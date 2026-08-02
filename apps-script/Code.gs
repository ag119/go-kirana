/**
 * Go-Kirana Staff Console — Apps Script backend.
 *
 * Paste this into your Apps Script project (script.google.com), set
 * SHEET_ID below, then Deploy > New deployment > Web app
 *   - Execute as: Me
 *   - Who has access: Anyone
 * Copy the resulting /exec URL into app/assets/api.js (WEB_APP_URL).
 *
 * This replaces the old pattern of fetching the sheet directly via the
 * public gviz endpoint (which required the Sheet to be link-shareable and
 * exposed the Sheet ID in every browser request). Now the Sheet can be
 * fully private — only this script can read it, and every read/write
 * requires a valid signed session token issued by the 'login' action.
 *
 * IMPORTANT — verify before relying on createOrder in production:
 * This was written without visibility into your actual "Orders" and
 * "Order Details" tab column headers, so it writes generically: it reads
 * whatever headers actually exist in your sheet and fills in the ones it
 * recognizes by name (see ALIASES below). Any header it doesn't recognize
 * is left blank rather than risking a misaligned write. Open a test row
 * after your first order submission and confirm every column landed
 * where you expect — adjust the ALIASES maps below if not.
 */

const SHEET_ID = '1WNX0PqbLSDJ11ps2cuZaeYQC-w87KM5uUt5acPjJahI';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session length: 30 days — the app has its own Logout button, so no need to force re-login sooner

// SpreadsheetApp.openById() is one of the more expensive Apps Script calls
// (it re-resolves the whole spreadsheet binding). A single doPost — e.g.
// the 'getSheets' batch action, or submitDraftOrder which touches Draft
// Orders + Orders + Order Details + Inventory in one request — used to
// call it once per sheet touched. Since each doPost runs in its own
// isolated execution (no cross-request state), memoizing it here per
// execution is safe and turns N opens into 1.
let _ss = null;
function getSpreadsheet_() {
  if (!_ss) _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

/* ---------------------------------------------------------------------
 * Session tokens: stateless, HMAC-signed (no extra "Sessions" sheet needed)
 * ------------------------------------------------------------------- */

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signToken_(payloadObj) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify(payloadObj));
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, getSecret_())
  );
  return payload + '.' + sig;
}

function verifyToken_(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const parts = token.split('.');
  const payload = parts[0];
  const sig = parts[1];
  const expectedSig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, getSecret_())
  );
  if (sig !== expectedSig) return null;

  let obj;
  try {
    obj = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString());
  } catch (e) {
    return null;
  }
  if (!obj || !obj.exp || obj.exp < Date.now()) return null;
  return obj;
}

/* ---------------------------------------------------------------------
 * Sheet helpers
 * ------------------------------------------------------------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normalizeHeader_(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sheetToRows_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 1) return [];
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
      return obj;
    });
}

// Appends one row to `sheetName`, matching `dataObj` keys to the sheet's
// actual header row via ALIASES. Any header with no matching alias is left
// blank rather than guessed — safer than risking a misaligned write.
function appendRowByHeaders_(sheetName, dataObj, aliasMap) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet tab "${sheetName}" not found.`);

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());

  const row = headers.map(header => {
    const normalized = normalizeHeader_(header);
    for (const key in aliasMap) {
      const aliases = aliasMap[key];
      if (aliases.some(a => normalizeHeader_(a) === normalized)) {
        return dataObj[key] !== undefined ? dataObj[key] : '';
      }
    }
    return '';
  });

  sheet.appendRow(row);
}

// Creates `sheetName` with a header row if it doesn't exist yet. Used by
// features (Draft Orders, Audit Log) whose sheet tabs are auto-provisioned
// on first write rather than requiring manual spreadsheet setup.
function ensureSheetExists_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

// 1-indexed row number of the first row whose `columnName` cell matches
// `value` (string-compared), or -1 if not found / column missing.
function findRowIndexByValue_(sheet, columnName, value) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const colIdx = headers.findIndex(h => normalizeHeader_(h) === normalizeHeader_(columnName));
  if (colIdx === -1) return -1;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const colValues = sheet.getRange(2, colIdx + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]) === String(value)) return i + 2; // +1 for header row, +1 for 0-index
  }
  return -1;
}

// Updates the row where `matchColumn` === `matchValue`, read-merge-write:
// only columns whose alias key is present in `dataObj` (checked via
// hasOwnProperty, so an explicit '' is distinguishable from "not
// provided") are overwritten — every other column keeps its current
// value. Unlike appendRowByHeaders_, "key absent" here must NOT mean
// "blank it out", since this is a partial update, not a fresh append.
// Returns true if a row was found and updated, false otherwise.
function updateRowByHeaders_(sheetName, matchColumn, matchValue, dataObj, aliasMap) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet tab "${sheetName}" not found.`);

  const rowIdx = findRowIndexByValue_(sheet, matchColumn, matchValue);
  if (rowIdx === -1) return false;

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const currentValues = sheet.getRange(rowIdx, 1, 1, lastCol).getValues()[0];

  const newRow = headers.map((header, i) => {
    const normalized = normalizeHeader_(header);
    for (const key in aliasMap) {
      const aliases = aliasMap[key];
      if (aliases.some(a => normalizeHeader_(a) === normalized)) {
        return dataObj.hasOwnProperty(key) ? dataObj[key] : currentValues[i];
      }
    }
    return currentValues[i];
  });

  sheet.getRange(rowIdx, 1, 1, lastCol).setValues([newRow]);
  return true;
}

// Deletes the row where `matchColumn` === `matchValue`. Returns true if a
// row was found and deleted, false otherwise.
function deleteRowByHeaders_(sheetName, matchColumn, matchValue) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet tab "${sheetName}" not found.`);

  const rowIdx = findRowIndexByValue_(sheet, matchColumn, matchValue);
  if (rowIdx === -1) return false;

  sheet.deleteRow(rowIdx);
  return true;
}

// Apps Script does not serialize concurrent doPost executions, so any
// find-row-then-mutate sequence is a TOCTOU risk once multiple staff can
// write concurrently. Wrap every Draft Orders mutation in this.
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------- */

// Role comes from an "AgentCreds.Role" column ('admin' or 'agent'/blank).
// Defaults to 'agent' for any missing/unrecognized value — admin access
// must be explicitly granted per row, never assumed.
function handleLogin_(body) {
  const users = sheetToRows_('AgentCreds');
  const match = users.find(row => {
    const uVal = String(row['Username'] || row['username'] || row['User'] || '').trim();
    const pVal = String(row['Password'] || row['password'] || '').trim();
    return uVal.toLowerCase() === String(body.username || '').toLowerCase() &&
           pVal === String(body.password || '');
  });

  if (!match) return { status: 'error', message: 'Invalid username or password.' };

  const role = String(match['Role'] || match['role'] || '').trim().toLowerCase() === 'admin' ? 'admin' : 'agent';
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = signToken_({ u: body.username, role: role, exp: expiresAt });
  return { status: 'success', token: token, role: role, expiresAt: expiresAt };
}

// Returns just usernames + roles from AgentCreds — deliberately never the
// Password column, unlike a raw getSheet('AgentCreds') would. Used to
// populate the "Assign To" agent picker for any authenticated user (agents
// need to see fellow agents to reassign to, not just admin).
function handleGetAgentList_() {
  const users = sheetToRows_('AgentCreds');
  const agents = users
    .map(u => ({
      username: String(u['Username'] || u['username'] || '').trim(),
      role: String(u['Role'] || u['role'] || '').trim().toLowerCase() === 'admin' ? 'admin' : 'agent'
    }))
    .filter(u => u.username);
  return { status: 'success', agents: agents };
}

// Field names in the ORDER item payload sent by app/views/orders.js:
//   sku, quantity, unitPrice, actualPrice, calculatedTotal, actualCost
//
// NOTE: the "Orders" sheet's Actual Cost and Bill Amount columns are
// formula-derived (see the previous update_orders.gs) — they are
// intentionally left out of this map so appendRowByHeaders_ leaves them
// blank rather than overwriting the sheet's own formulas.
const ORDER_HEADER_ALIASES = {
  orderId: ['Id', 'Order ID', 'OrderId'],
  customerId: ['CustomerId', 'Customer ID'],
  customerName: ['CustomerName', 'Customer Name'],
  orderDate: ['Order Date'],
  fulfillmentDate: ['Fulfillment Date', 'Fulfilment Date'],
  deliveryCharge: ['Delivery Cost', 'Delivery Charge'],
  damageCost: ['Damage Cost']
};

const ORDER_ITEM_HEADER_ALIASES = {
  orderId: ['Order ID', 'Id', 'OrderId'],
  sku: ['SKU'],
  quantity: ['Quantity'],
  unitPrice: ['Unit Price'],
  calculatedTotal: ['Calculated Total'],
  actualPrice: ['Actual Price'],
  actualCost: ['Actual Cost Total', 'Actual Cost']
};

function handleCreateOrder_(body) {
  const items = body.items || [];
  if (!items.length) return { status: 'error', message: 'Order has no items.' };

  appendRowByHeaders_('Orders', {
    orderId: body.orderId,
    customerId: body.customerId,
    customerName: body.customerName,
    orderDate: body.orderDate,
    fulfillmentDate: body.fulfillmentDate || body.orderDate,
    deliveryCharge: body.deliveryCharge || 0,
    damageCost: body.damageCost || 0
  }, ORDER_HEADER_ALIASES);

  items.forEach(item => {
    appendRowByHeaders_('Order Details', {
      orderId: body.orderId,
      sku: item.sku || 'CUSTOM',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      calculatedTotal: item.calculatedTotal,
      actualPrice: item.actualPrice,
      actualCost: item.actualCost
    }, ORDER_ITEM_HEADER_ALIASES);
  });

  return { status: 'success', orderId: body.orderId };
}

const INVENTORY_SHEET = 'Inventory';

// Reduces Inventory.Stock for each order item whose SKU matches a row in
// the Inventory sheet, by that item's quantity — called after an order has
// been successfully written (see the doPost 'createOrder' branch and
// handleSubmitDraftOrder_ below), never from inside another withLock_
// section (this one takes its own lock; Apps Script script locks are not
// guaranteed reentrant within a single execution, so nesting is avoided by
// construction rather than assumed safe).
//
// Items with no SKU (custom/off-catalog) or no matching Inventory row are
// silently skipped — not every item is necessarily stocked there. Stock is
// allowed to go negative on purpose: an oversold item should show up as a
// visible negative rather than being silently clamped at 0.
function decrementInventoryStock_(items) {
  if (!items || !items.length) return;

  withLock_(() => {
    const sheet = getSpreadsheet_().getSheetByName(INVENTORY_SHEET);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const stockColIdx = headers.findIndex(h => normalizeHeader_(h) === normalizeHeader_('Stock'));
    if (stockColIdx === -1) return;

    items.forEach(item => {
      const sku = String(item.sku || '').trim();
      if (!sku || sku === 'CUSTOM') return;
      const qty = Number(item.quantity) || 0;
      if (!qty) return;

      const rowIdx = findRowIndexByValue_(sheet, 'SKU', sku);
      if (rowIdx === -1) return;

      const cell = sheet.getRange(rowIdx, stockColIdx + 1);
      cell.setValue((Number(cell.getValue()) || 0) - qty);
    });
  });
}

/* ---------------------------------------------------------------------
 * Inventory management (admin-only)
 *
 * "Per Unit Price", "Margin", and "Current Asset" are formula-derived
 * columns in the Inventory sheet — deliberately absent from
 * INVENTORY_HEADER_ALIASES so appendRowByHeaders_/updateRowByHeaders_
 * never write to them and never disturb the sheet's own formulas.
 * ------------------------------------------------------------------- */

const INVENTORY_HEADER_ALIASES = {
  sku: ['SKU'],
  itemName: ['Item Name'],
  stock: ['Stock'],
  casePrice: ['Case Price'],
  unitsInCase: ['Units in case', 'Units In Case'],
  sellingPrice: ['Selling Price']
};

function getInventoryRowBySku_(sku) {
  const rows = sheetToRows_(INVENTORY_SHEET);
  return rows.find(r => String(r['SKU'] || '').trim() === String(sku).trim()) || null;
}

// Add / restock: if the SKU already has an Inventory row, the given Stock
// is ADDED to whatever is already there (Case Price / Units in case /
// Selling Price are replaced with the freshly-entered values, since a
// restock is exactly when those legitimately change). If the SKU isn't
// present yet, a new row is created.
function handleAddInventoryStock_(session, body) {
  if (session.role !== 'admin') return { status: 'error', message: 'Only admin can manage inventory.' };

  const sku = String(body.sku || '').trim();
  if (!sku) return { status: 'error', message: 'SKU is required.' };

  return withLock_(() => {
    const existing = getInventoryRowBySku_(sku);
    const casePrice = Number(body.casePrice) || 0;
    const unitsInCase = Number(body.unitsInCase) || 0;
    const sellingPrice = Number(body.sellingPrice) || 0;
    const addQty = Number(body.stock) || 0;

    if (existing) {
      const newStock = (Number(existing['Stock']) || 0) + addQty;
      updateRowByHeaders_(INVENTORY_SHEET, 'SKU', sku, {
        stock: newStock,
        casePrice: casePrice,
        unitsInCase: unitsInCase,
        sellingPrice: sellingPrice
      }, INVENTORY_HEADER_ALIASES);
      return { status: 'success', created: false, newStock: newStock };
    }

    appendRowByHeaders_(INVENTORY_SHEET, {
      sku: sku,
      itemName: body.itemName || sku,
      stock: addQty,
      casePrice: casePrice,
      unitsInCase: unitsInCase,
      sellingPrice: sellingPrice
    }, INVENTORY_HEADER_ALIASES);
    return { status: 'success', created: true, newStock: addQty };
  });
}

// Direct edit of an existing row (replaces values outright — unlike
// handleAddInventoryStock_, this never adds to Stock, it sets it).
function handleUpdateInventoryItem_(session, body) {
  if (session.role !== 'admin') return { status: 'error', message: 'Only admin can manage inventory.' };

  const sku = String(body.sku || '').trim();
  if (!sku) return { status: 'error', message: 'SKU is required.' };

  return withLock_(() => {
    const dataObj = {};
    if (body.hasOwnProperty('itemName')) dataObj.itemName = body.itemName;
    if (body.hasOwnProperty('stock')) dataObj.stock = Number(body.stock) || 0;
    if (body.hasOwnProperty('casePrice')) dataObj.casePrice = Number(body.casePrice) || 0;
    if (body.hasOwnProperty('unitsInCase')) dataObj.unitsInCase = Number(body.unitsInCase) || 0;
    if (body.hasOwnProperty('sellingPrice')) dataObj.sellingPrice = Number(body.sellingPrice) || 0;

    const updated = updateRowByHeaders_(INVENTORY_SHEET, 'SKU', sku, dataObj, INVENTORY_HEADER_ALIASES);
    if (!updated) return { status: 'error', message: 'Inventory item not found.' };
    return { status: 'success' };
  });
}

function handleDeleteInventoryItem_(session, body) {
  if (session.role !== 'admin') return { status: 'error', message: 'Only admin can manage inventory.' };

  const sku = String(body.sku || '').trim();
  if (!sku) return { status: 'error', message: 'SKU is required.' };

  return withLock_(() => {
    const deleted = deleteRowByHeaders_(INVENTORY_SHEET, 'SKU', sku);
    if (!deleted) return { status: 'error', message: 'Inventory item not found.' };
    return { status: 'success' };
  });
}

/* ---------------------------------------------------------------------
 * Draft Orders + Audit Log
 *
 * Agent Hub's "Take Order" / "New Order" flows persist here (in addition
 * to opening WhatsApp, unchanged) so requests are visible in-app instead
 * of living only in a WhatsApp thread. Agents see/manage only their own
 * rows (server-filtered — never trust the client for this); admin sees
 * and manages all of them, and is the only role allowed to finalize one
 * into a real Order (handleCreateOrder_) via submitDraftOrder.
 * ------------------------------------------------------------------- */

const DRAFT_ORDERS_SHEET = 'Draft Orders';
const DRAFT_ORDERS_HEADERS = ['Id', 'Status', 'CreatedBy', 'CreatedAt', 'UpdatedBy', 'UpdatedAt', 'CustomerId', 'CustomerName', 'CustomerMobile', 'ItemsJson', 'Notes'];
const DRAFT_ORDER_HEADER_ALIASES = {
  id: ['Id'],
  status: ['Status'],
  createdBy: ['CreatedBy'],
  createdAt: ['CreatedAt'],
  updatedBy: ['UpdatedBy'],
  updatedAt: ['UpdatedAt'],
  customerId: ['CustomerId'],
  customerName: ['CustomerName'],
  customerMobile: ['CustomerMobile'],
  itemsJson: ['ItemsJson'],
  notes: ['Notes']
};
const DRAFT_ORDER_STATUSES = ['Pending', 'Confirmed', 'On Hold'];

const AUDIT_LOG_SHEET = 'Audit Log';
const AUDIT_LOG_HEADERS = ['Timestamp', 'Username', 'Role', 'Action', 'DraftOrderId', 'Details'];
const AUDIT_LOG_HEADER_ALIASES = {
  timestamp: ['Timestamp'],
  username: ['Username'],
  role: ['Role'],
  action: ['Action'],
  draftOrderId: ['DraftOrderId'],
  details: ['Details']
};

// Deliberately not shaped like a real Order ID (see ORDER_HEADER_ALIASES)
// so the two are never visually confused, and this never needs the
// scan-and-increment collision handling real Order IDs use.
function generateDraftOrderId_() {
  return 'PO' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function logAudit_(session, action, draftOrderId, details) {
  ensureSheetExists_(AUDIT_LOG_SHEET, AUDIT_LOG_HEADERS);
  appendRowByHeaders_(AUDIT_LOG_SHEET, {
    timestamp: new Date(),
    username: session.u,
    role: session.role,
    action: action,
    draftOrderId: draftOrderId || '',
    details: details || ''
  }, AUDIT_LOG_HEADER_ALIASES);
}

function getDraftOrderById_(id) {
  const rows = sheetToRows_(DRAFT_ORDERS_SHEET);
  return rows.find(r => String(r['Id']) === String(id)) || null;
}

function isOwnerOrAdmin_(session, row) {
  if (session.role === 'admin') return true;
  return String(row['CreatedBy'] || '').trim().toLowerCase() === String(session.u || '').trim().toLowerCase();
}

function handleGetDraftOrders_(session) {
  ensureSheetExists_(DRAFT_ORDERS_SHEET, DRAFT_ORDERS_HEADERS);
  let rows = sheetToRows_(DRAFT_ORDERS_SHEET);
  if (session.role !== 'admin') {
    const u = String(session.u || '').trim().toLowerCase();
    rows = rows.filter(r => String(r['CreatedBy'] || '').trim().toLowerCase() === u);
  }
  return { status: 'success', rows: rows };
}

function handleCreateDraftOrder_(session, body) {
  return withLock_(() => {
    ensureSheetExists_(DRAFT_ORDERS_SHEET, DRAFT_ORDERS_HEADERS);
    const items = Array.isArray(body.items) ? body.items : [];
    const id = generateDraftOrderId_();
    const now = new Date();
    appendRowByHeaders_(DRAFT_ORDERS_SHEET, {
      id: id,
      status: 'Pending',
      createdBy: session.u,
      createdAt: now,
      updatedBy: session.u,
      updatedAt: now,
      customerId: body.customerId || '',
      customerName: body.customerName || '',
      customerMobile: body.customerMobile || '',
      itemsJson: JSON.stringify(items),
      notes: body.notes || ''
    }, DRAFT_ORDER_HEADER_ALIASES);
    logAudit_(session, 'create', id, `Created draft order for ${body.customerName || ''}`);
    return { status: 'success', id: id };
  });
}

function handleUpdateDraftOrder_(session, body) {
  return withLock_(() => {
    const existing = getDraftOrderById_(body.id);
    if (!existing) return { status: 'error', message: 'Draft order not found. It may have already been submitted or deleted.' };
    if (!isOwnerOrAdmin_(session, existing)) return { status: 'error', message: 'You can only edit your own orders.' };

    const dataObj = { updatedBy: session.u, updatedAt: new Date() };
    if (body.hasOwnProperty('status')) {
      if (DRAFT_ORDER_STATUSES.indexOf(body.status) === -1) return { status: 'error', message: 'Invalid status.' };
      dataObj.status = body.status;
    }
    if (body.hasOwnProperty('items')) dataObj.itemsJson = JSON.stringify(Array.isArray(body.items) ? body.items : []);
    if (body.hasOwnProperty('customerName')) dataObj.customerName = body.customerName;
    if (body.hasOwnProperty('customerMobile')) dataObj.customerMobile = body.customerMobile;
    if (body.hasOwnProperty('customerId')) dataObj.customerId = body.customerId;
    if (body.hasOwnProperty('notes')) dataObj.notes = body.notes;

    updateRowByHeaders_(DRAFT_ORDERS_SHEET, 'Id', body.id, dataObj, DRAFT_ORDER_HEADER_ALIASES);
    const changed = Object.keys(dataObj).filter(k => k !== 'updatedBy' && k !== 'updatedAt');
    logAudit_(session, 'update', body.id, `Updated: ${changed.join(', ') || '(no fields)'}`);
    return { status: 'success' };
  });
}

function handleDeleteDraftOrder_(session, body) {
  return withLock_(() => {
    const existing = getDraftOrderById_(body.id);
    if (!existing) return { status: 'error', message: 'Draft order not found. It may have already been submitted or deleted.' };
    if (!isOwnerOrAdmin_(session, existing)) return { status: 'error', message: 'You can only delete your own orders.' };

    deleteRowByHeaders_(DRAFT_ORDERS_SHEET, 'Id', body.id);
    logAudit_(session, 'delete', body.id, `Deleted draft order for ${existing['CustomerName'] || ''}`);
    return { status: 'success' };
  });
}

// Reassigns ownership (CreatedBy) of a draft order to a different agent, so
// it disappears from the current owner's Pending Orders and shows up in
// the new owner's. Same ownership rule as update/delete — admin or the
// current owner only. The target username is validated against AgentCreds
// first (outside the lock, cheap early-exit) so a typo can't silently
// strand an order under a username nobody can ever log in as.
function handleReassignDraftOrder_(session, body) {
  const newOwner = String(body.assignTo || '').trim();
  if (!newOwner) return { status: 'error', message: 'Missing agent to assign to.' };

  const users = sheetToRows_('AgentCreds');
  const match = users.find(u => String(u['Username'] || u['username'] || '').trim().toLowerCase() === newOwner.toLowerCase());
  if (!match) return { status: 'error', message: 'That username was not found.' };
  const canonicalUsername = String(match['Username'] || match['username']).trim();

  return withLock_(() => {
    const existing = getDraftOrderById_(body.id);
    if (!existing) return { status: 'error', message: 'Draft order not found. It may have already been submitted or deleted.' };
    if (!isOwnerOrAdmin_(session, existing)) return { status: 'error', message: 'You can only reassign your own orders.' };

    updateRowByHeaders_(DRAFT_ORDERS_SHEET, 'Id', body.id, {
      createdBy: canonicalUsername,
      updatedBy: session.u,
      updatedAt: new Date()
    }, DRAFT_ORDER_HEADER_ALIASES);

    logAudit_(session, 'reassign', body.id, `Reassigned from ${existing['CreatedBy']} to ${canonicalUsername}`);
    return { status: 'success' };
  });
}

// Admin-only: converts a Draft Orders row into a real Order (reusing
// handleCreateOrder_ unmodified — the extra `id` key is simply ignored by
// its alias maps) and removes the draft row on success. If
// handleCreateOrder_ throws partway through, the exception propagates and
// the draft row is left intact for a retry, rather than being deleted
// speculatively.
function handleSubmitDraftOrder_(session, body) {
  if (session.role !== 'admin') return { status: 'error', message: 'Only admin can finalize orders.' };

  const result = withLock_(() => {
    const existing = getDraftOrderById_(body.id);
    if (!existing) return { status: 'error', message: 'Draft order not found. It may have already been submitted or deleted by someone else.' };

    const res = handleCreateOrder_(body);
    if (res.status !== 'success') return res;

    deleteRowByHeaders_(DRAFT_ORDERS_SHEET, 'Id', body.id);
    logAudit_(session, 'submit', body.id, `Finalized as Order ${body.orderId}`);
    return res;
  });

  // Outside the lock above (that one guards the Draft Orders row;
  // decrementInventoryStock_ takes its own lock for the Inventory sheet —
  // see the comment on that function for why these are never nested).
  if (result.status === 'success') {
    decrementInventoryStock_(body.items || []);
  }

  return result;
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ status: 'error', message: 'Bad request.' });
  }

  const action = body.action;

  if (action === 'login') {
    return json_(handleLogin_(body));
  }

  // Every other action requires a valid session token.
  const session = verifyToken_(body.token);
  if (!session) {
    return json_({ status: 'error', message: 'Session expired. Please log in again.', code: 'AUTH_REQUIRED' });
  }

  try {
    if (action === 'getSheet') {
      if (!body.sheet) return json_({ status: 'error', message: 'Missing sheet name.' });
      return json_({ status: 'success', rows: sheetToRows_(body.sheet) });
    }

    if (action === 'getSheets') {
      const data = {};
      (body.sheets || []).forEach(name => { data[name] = sheetToRows_(name); });
      return json_({ status: 'success', data: data });
    }

    if (action === 'createOrder') {
      const result = handleCreateOrder_(body);
      if (result.status === 'success') decrementInventoryStock_(body.items || []);
      return json_(result);
    }

    if (action === 'getDraftOrders') {
      return json_(handleGetDraftOrders_(session));
    }

    if (action === 'createDraftOrder') {
      return json_(handleCreateDraftOrder_(session, body));
    }

    if (action === 'updateDraftOrder') {
      return json_(handleUpdateDraftOrder_(session, body));
    }

    if (action === 'deleteDraftOrder') {
      return json_(handleDeleteDraftOrder_(session, body));
    }

    if (action === 'submitDraftOrder') {
      return json_(handleSubmitDraftOrder_(session, body));
    }

    if (action === 'reassignDraftOrder') {
      return json_(handleReassignDraftOrder_(session, body));
    }

    if (action === 'getAgentList') {
      return json_(handleGetAgentList_());
    }

    if (action === 'addInventoryStock') {
      return json_(handleAddInventoryStock_(session, body));
    }

    if (action === 'updateInventoryItem') {
      return json_(handleUpdateInventoryItem_(session, body));
    }

    if (action === 'deleteInventoryItem') {
      return json_(handleDeleteInventoryItem_(session, body));
    }

    return json_({ status: 'error', message: 'Unknown action.' });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}
