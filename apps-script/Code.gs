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
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheetName);
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
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheetName);
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
      return json_(handleCreateOrder_(body));
    }

    return json_({ status: 'error', message: 'Unknown action.' });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}
