/* Go-Kirana — Record Order view (desktop order & line-item logger).
   Loaded fresh by the shell router on every navigation to #/orders. */
(function () {
    'use strict';

    let rawCustomers = [];
    let rawOrders = [];
    let rawProducts = [];
    let sheetOrderCart = [];

    // Local-only draft orders — never sent to the server, live entirely in
    // localStorage on this device/browser.
    const DRAFTS_STORAGE_KEY = 'gk_order_drafts';
    let drafts = [];
    let activeDraftId = null;

    // --- RELEVANCE SEARCH & FUZZY MATCHING (identical to Agent Hub / Admin's
    // product search, so the experience is the same across every view). ---
    function levenshteinDistance(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    function fuzzyMatch(text, query) {
        if (!text || !query) return false;
        text = text.toLowerCase();
        query = query.toLowerCase();

        if (text.includes(query)) return true;

        const words = text.split(/[\s,]+/);
        for (let word of words) {
            if (Math.abs(word.length - query.length) <= 2) {
                const dist = levenshteinDistance(word, query);
                if (dist <= 2) return true;
            }
        }
        return false;
    }

    function getMatchScore(product, query) {
        if (!query) return 0;

        const q = query.toLowerCase().trim();
        const sku = (product['SKU'] || '').toLowerCase().trim();
        const name = (product['Item Name'] || product['Standard Name'] || '').toLowerCase().trim();
        const rawKeywords = (product['Search Keywords'] || product['Keywords'] || '').toLowerCase().trim();
        const keywords = rawKeywords.split(',').map(k => k.trim());

        if (name === q || sku === q) return 100;
        if (name.startsWith(q) || sku.startsWith(q)) return 90;

        const nameWords = name.split(/[\s,]+/);
        if (nameWords.some(w => w === q)) return 80;
        if (nameWords.some(w => w.startsWith(q))) return 70;
        if (name.includes(q)) return 60;

        for (let kw of keywords) {
            if (!kw) continue;
            if (kw === q) return 55;
            if (kw.startsWith(q)) return 50;
            if (kw.includes(q)) return 40;
        }

        if (fuzzyMatch(name, q) || fuzzyMatch(sku, q)) return 20;
        for (let kw of keywords) {
            if (kw && fuzzyMatch(kw, q)) return 15;
        }

        return 0;
    }

    function findBestProductMatch(query) {
        if (!query) return null;

        let bestProduct = null;
        let highestScore = 0;

        const cleanQuery = query.trim();

        rawProducts.forEach(p => {
            const score = getMatchScore(p, cleanQuery);
            if (score > highestScore) {
                highestScore = score;
                bestProduct = p;
            }
        });

        if (bestProduct && highestScore > 0) {
            const sku = (bestProduct['SKU'] || '').trim();
            const name = bestProduct['Item Name'] || bestProduct['Standard Name'] || sku;
            const price = parseFloat(bestProduct['Price per Unit'] || bestProduct['Price'] || 0);
            const costPrice = parseFloat(bestProduct['Cost Price'] || bestProduct['Actual Price'] || bestProduct['Cost'] || 0);

            return { sku, name, price, costPrice };
        }

        return null;
    }

    function handleSearchSuggestInput(inputEl, dropdownId) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;

        const query = inputEl.value.trim();
        if (!query) {
            dropdown.style.display = 'none';
            return;
        }

        const scoredMatches = rawProducts
            .map(p => ({ product: p, score: getMatchScore(p, query) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

        if (!scoredMatches.length) {
            dropdown.style.display = 'none';
            return;
        }

        dropdown.innerHTML = scoredMatches.map(m => {
            const p = m.product;
            const sku = (p['SKU'] || '').trim();
            const name = p['Item Name'] || p['Standard Name'] || sku;
            const price = parseFloat(p['Price per Unit'] || 0);

            return `
            <div class="custom-suggest-item" onclick="selectSuggestedProduct('${inputEl.id}', '${dropdownId}', '${name.replace(/'/g, "\'")}')">
                <span>${name}</span>
                <span style="color:var(--primary-dark); font-weight:800;">₹${price.toLocaleString('en-IN', {maximumFractionDigits:2})}</span>
            </div>
            `;
        }).join('');

        dropdown.style.display = 'block';
    }

    function selectSuggestedProduct(inputId, dropdownId, name) {
        document.getElementById(inputId).value = name;
        document.getElementById(dropdownId).style.display = 'none';
    }

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.custom-suggest-container')) {
            document.querySelectorAll('.custom-suggest-dropdown').forEach(d => d.style.display = 'none');
        }
    });

    // force=true bypasses the shared localStorage cache (see app/assets/api.js) —
    // used by the shell's Refresh button and after submitting a new order.
    async function fetchLiveData(force) {
        try {
            const [cust, ord, prods] = await Promise.all([
                GK.api.getSheet('Customers', { force }),
                GK.api.getSheet('Orders', { force }),
                GK.api.getSheet('Products', { force })
            ]);

            rawCustomers = cust;
            rawOrders = ord;
            rawProducts = prods;

            const custDatalist = document.getElementById('customerDatalist');
            custDatalist.innerHTML = rawCustomers.map(c => {
                const id = c['Id'] || c['ID'] || '';
                const name = c['Owner Name'] || '';
                const mobile = c['Mobile Number'] || '';
                return `<option value="${name} - ${mobile} [ID: ${id}]"></option>`;
            }).join('');

            recalculateAutoOrderId();
        } catch (err) {
            console.error(err);
            alert('⚠️ Error syncing live data from Google Sheet.');
        }
    }

    function onCustomerSelected() {
        const val = document.getElementById('orderCustInput').value.trim();
        const statusDiv = document.getElementById('custSelectionStatus');
        const hiddenId = document.getElementById('selectedCustId');
        const hiddenName = document.getElementById('selectedCustName');

        let found = rawCustomers.find(c => {
            const id = (c['Id'] || c['ID'] || '').toString().trim();
            const name = (c['Owner Name'] || '').toString().trim();
            const mobile = (c['Mobile Number'] || '').toString().trim();
            const comboStr = `${name} - ${mobile} [ID: ${id}]`.toLowerCase();

            return comboStr === val.toLowerCase() ||
                   name.toLowerCase() === val.toLowerCase() ||
                   mobile === val ||
                   (id && id.toLowerCase() === val.toLowerCase());
        });

        if (found) {
            const cId = found['Id'] || found['ID'] || '';
            const cName = found['Owner Name'] || '';
            hiddenId.value = cId;
            hiddenName.value = cName;
            statusDiv.style.display = 'block';
            statusDiv.innerText = `✔ Selected: ${cName} (ID: ${cId})`;
        } else {
            hiddenId.value = '';
            hiddenName.value = '';
            statusDiv.style.display = 'none';
        }
    }

    // Considers both the live sheet (rawOrders) and any OTHER saved drafts
    // for the same date, so two drafts queued for the same day never preview
    // the same ID. Still only a preview — submitOrderToGoogleSheet() re-runs
    // this against freshly-fetched sheet data right before writing, so it
    // stays correct even if someone else recorded an order in the meantime.
    function recalculateAutoOrderId() {
        const dateInput = document.getElementById('orderDateInput');
        let dateVal = dateInput.value;
        if (!dateVal) {
            dateVal = new Date().toISOString().substring(0, 10);
            dateInput.value = dateVal;
        }

        const yyyymmdd = dateVal.replace(/-/g, '');
        const prefix = 'GKO' + yyyymmdd;

        const seqOf = (id) => {
            const s = String(id || '').trim();
            if (!s.startsWith(prefix)) return 0;
            const n = parseInt(s.substring(prefix.length), 10);
            return isNaN(n) ? 0 : n;
        };

        let maxSeq = 0;
        rawOrders.forEach(o => {
            maxSeq = Math.max(maxSeq, seqOf(o['Id'] || o['Order ID']));
        });
        drafts.forEach(d => {
            if (d.id === activeDraftId) return; // don't let a draft collide with its own already-reserved ID
            if (d.orderDate === dateVal) maxSeq = Math.max(maxSeq, seqOf(d.orderId));
        });

        const autoId = prefix + String(maxSeq + 1).padStart(8, '0');
        document.getElementById('autoGeneratedOrderId').innerText = autoId;
        return autoId;
    }

    function adjustSearchQty(delta) {
        const qtyInput = document.getElementById('orderProductSearchQty');
        let current = parseInt(qtyInput.value) || 1;
        current += delta;
        if (current < 1) current = 1;
        qtyInput.value = current;
    }

    function addSelectedProductToTable() {
        const searchInput = document.getElementById('orderProductSearchInput');
        const qtyInput = document.getElementById('orderProductSearchQty');
        const dropdown = document.getElementById('orderProductDropdown');

        const val = searchInput.value.trim();
        const qty = parseInt(qtyInput.value) || 1;

        if (!val) return;

        const matched = findBestProductMatch(val);

        if (matched) {
            sheetOrderCart.push({ sku: matched.sku, name: matched.name, qty, unitPrice: matched.price, costPrice: matched.costPrice || 0 });
        } else {
            sheetOrderCart.push({ sku: 'CUSTOM', name: val, qty, unitPrice: 0, costPrice: 0 });
        }

        searchInput.value = '';
        qtyInput.value = '1';
        if (dropdown) dropdown.style.display = 'none';
        renderSheetOrderTable();
    }

    function updateSheetOrderItemQty(idx, newQty) {
        const q = parseInt(newQty) || 1;
        sheetOrderCart[idx].qty = q > 0 ? q : 1;
        renderSheetOrderTable();
    }

    function updateSheetOrderItemUnitPrice(idx, newPrice) {
        sheetOrderCart[idx].unitPrice = parseFloat(newPrice) || 0;
        renderSheetOrderTable();
    }

    function updateSheetOrderItemCostPrice(idx, newCost) {
        sheetOrderCart[idx].costPrice = parseFloat(newCost) || 0;
        renderSheetOrderTable();
    }

    function removeSheetOrderItem(idx) {
        sheetOrderCart.splice(idx, 1);
        renderSheetOrderTable();
    }

    function renderSheetOrderTable() {
        const tbody = document.getElementById('sheetOrderItemsTableBody');
        if (!sheetOrderCart.length) {
            tbody.innerHTML = `<tr><td colspan="8" style="padding:24px; text-align:center; color:var(--text-muted);">No items added yet. Search and add products above.</td></tr>`;
            renderSheetOrderSummary();
            return;
        }

        tbody.innerHTML = sheetOrderCart.map((item, idx) => {
            const totalBilled = (item.qty * item.unitPrice).toFixed(2);
            const totalCost = (item.qty * item.costPrice).toFixed(2);

            return `
            <tr>
                <td><code style="font-size:0.75rem; color:var(--text-muted);">${item.sku || 'N/A'}</code></td>
                <td style="font-weight:700;">${item.name}</td>
                <td style="text-align:center;">
                    <div style="display:inline-flex; align-items:center; gap:4px;">
                        <button style="border:none; background:#e2e8f0; width:26px; height:26px; border-radius:4px; font-weight:800; cursor:pointer;" onclick="updateSheetOrderItemQty(${idx}, ${item.qty - 1})">-</button>
                        <input type="number" value="${item.qty}" min="1" style="width:45px; text-align:center; border:1px solid var(--border); border-radius:4px; padding:2px; font-weight:700;" onchange="updateSheetOrderItemQty(${idx}, this.value)">
                        <button style="border:none; background:#e2e8f0; width:26px; height:26px; border-radius:4px; font-weight:800; cursor:pointer;" onclick="updateSheetOrderItemQty(${idx}, ${item.qty + 1})">+</button>
                    </div>
                </td>
                <td style="text-align:right;">
                    <input type="number" step="0.01" value="${item.unitPrice}" style="width:90px; text-align:right; border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-weight:700;" onchange="updateSheetOrderItemUnitPrice(${idx}, this.value)">
                </td>
                <td style="text-align:right; font-weight:800; color:var(--primary-dark);">₹${parseFloat(totalBilled).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                <td style="text-align:right;">
                    <input type="number" step="0.01" value="${item.costPrice}" style="width:90px; text-align:right; border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-weight:700;" onchange="updateSheetOrderItemCostPrice(${idx}, this.value)">
                </td>
                <td style="text-align:right; font-weight:800; color:var(--text-muted);">₹${parseFloat(totalCost).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                <td style="text-align:center;">
                    <button style="border:none; background:none; color:red; font-weight:bold; cursor:pointer; font-size:1rem;" onclick="removeSheetOrderItem(${idx})">✕</button>
                </td>
            </tr>
            `;
        }).join('');

        renderSheetOrderSummary();
    }

    function renderSheetOrderSummary() {
        let itemsBilledTotal = 0;
        let itemsCostTotal = 0;

        sheetOrderCart.forEach(item => {
            itemsBilledTotal += (item.qty * item.unitPrice);
            itemsCostTotal += (item.qty * item.costPrice);
        });

        const delCharge = parseFloat(document.getElementById('orderDeliveryCharge').value) || 0;
        const damageCost = parseFloat(document.getElementById('orderDamageCost').value) || 0;

        const finalBilled = itemsBilledTotal + delCharge;
        const finalCost = itemsCostTotal + damageCost;
        const profitLoss = finalBilled - finalCost;
        const marginPct = finalBilled > 0 ? ((profitLoss / finalBilled) * 100).toFixed(2) : '0.00';

        document.getElementById('sumBilledAmount').innerText = `₹${finalBilled.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        document.getElementById('sumActualCost').innerText = `₹${finalCost.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

        const profitEl = document.getElementById('sumProfitLoss');
        profitEl.innerText = `₹${profitLoss.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        profitEl.style.color = profitLoss >= 0 ? '#10b981' : '#ef4444';

        const marginEl = document.getElementById('sumProfitMargin');
        marginEl.innerText = `${marginPct}%`;
        marginEl.style.color = profitLoss >= 0 ? '#10b981' : '#ef4444';
    }

    async function submitOrderToGoogleSheet() {
        const custId = document.getElementById('selectedCustId').value;
        const custName = document.getElementById('selectedCustName').value;
        const orderDate = document.getElementById('orderDateInput').value;
        const fulfillmentDate = document.getElementById('fulfillmentDateInput').value;

        if (!custName || !custId) {
            alert('Please select a valid Customer from the search list.');
            document.getElementById('orderCustInput').focus();
            return;
        }
        if (!orderDate) { alert('Please select a valid Order Date.'); return; }
        if (!fulfillmentDate) { alert('Please select a valid Fulfilment Date.'); return; }
        if (!sheetOrderCart.length) { alert('Please add at least one item to the order table.'); return; }

        const btn = document.getElementById('btnSubmitSheetOrder');
        btn.disabled = true;
        btn.innerHTML = '🔄 Syncing latest order ID...';

        // Re-fetch Orders fresh (bypassing the cache) right before minting the
        // final ID, so it stays correct even if someone else recorded an
        // order for this date in the meantime. Best-effort: if this fails
        // (e.g. offline), fall back to whatever Orders data is already loaded
        // rather than blocking the submit entirely.
        try {
            rawOrders = await GK.api.getSheet('Orders', { force: true });
        } catch (err) {
            console.error('Could not refresh Orders before submit, using last-known data:', err);
        }

        const autoId = recalculateAutoOrderId();
        const delCharge = parseFloat(document.getElementById('orderDeliveryCharge').value) || 0;
        const damageCost = parseFloat(document.getElementById('orderDamageCost').value) || 0;

        btn.innerHTML = '⏳ Submitting Order to Google Sheet...';

        const payload = {
            orderId: autoId,
            orderDate: orderDate,
            fulfillmentDate: fulfillmentDate,
            customerId: custId,
            customerName: custName,
            deliveryCharge: delCharge,
            damageCost: damageCost,
            items: sheetOrderCart.map(i => ({
                sku: i.sku || 'CUSTOM',
                quantity: i.qty,
                unitPrice: i.unitPrice,
                actualPrice: i.costPrice,
                calculatedTotal: (i.qty * i.unitPrice),
                actualCost: (i.qty * i.costPrice)
            }))
        };

        try {
            await GK.api.createOrder(payload);
            alert(`✅ Order ${autoId} recorded successfully in Google Sheet!`);

            if (activeDraftId) {
                drafts = drafts.filter(d => d.id !== activeDraftId);
                persistDrafts();
                renderDraftsList();
            }
            clearOrderForm();

            fetchLiveData(true);
        } catch (err) {
            console.error(err);
            alert(`⚠️ Error submitting order: ${err.message || 'Unknown error'}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '🚀 Submit Order to Google Sheet';
        }
    }

    // --- LOCAL-ONLY DRAFT ORDERS -------------------------------------------
    // Saved to localStorage only — never touch the Apps Script API. Lets an
    // admin build up several orders before deciding what to actually submit,
    // and see the combined SKU quantities needed to fulfil all of them.

    function loadDraftsFromStorage() {
        try {
            const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
            drafts = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(drafts)) drafts = [];
        } catch (e) {
            drafts = [];
        }
    }

    function persistDrafts() {
        try {
            localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
        } catch (e) {
            alert('⚠️ Could not save draft — your browser storage may be full.');
        }
    }

    function setEditingBanner(active) {
        const banner = document.getElementById('draftEditBanner');
        if (banner) banner.style.display = active ? 'flex' : 'none';
    }

    function draftItemsBilledTotal(draft) {
        const itemsTotal = (draft.items || []).reduce((sum, i) => sum + (i.qty * i.unitPrice), 0);
        return itemsTotal + (parseFloat(draft.deliveryCharge) || 0);
    }

    function formatSavedAt(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '—';
        return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function saveDraft() {
        if (!sheetOrderCart.length) {
            alert('Add at least one item before saving a draft.');
            return;
        }

        const orderDate = document.getElementById('orderDateInput').value;
        const existingIdx = activeDraftId ? drafts.findIndex(d => d.id === activeDraftId) : -1;
        const existing = existingIdx !== -1 ? drafts[existingIdx] : null;

        // Reuse the draft's already-reserved ID as long as its date hasn't
        // changed — resaving the same draft shouldn't keep bumping its ID.
        // A new draft, or one whose date just changed, mints a fresh one
        // (recalculateAutoOrderId already accounts for every OTHER draft on
        // that date, so two same-day drafts never collide).
        const orderId = (existing && existing.orderDate === orderDate && existing.orderId)
            ? existing.orderId
            : recalculateAutoOrderId();

        const draftData = {
            orderId,
            custId: document.getElementById('selectedCustId').value,
            custName: document.getElementById('selectedCustName').value,
            custInputValue: document.getElementById('orderCustInput').value.trim(),
            orderDate: orderDate,
            fulfillmentDate: document.getElementById('fulfillmentDateInput').value,
            deliveryCharge: parseFloat(document.getElementById('orderDeliveryCharge').value) || 0,
            damageCost: parseFloat(document.getElementById('orderDamageCost').value) || 0,
            items: sheetOrderCart.map(i => Object.assign({}, i))
        };

        if (existingIdx !== -1) {
            drafts[existingIdx] = Object.assign({}, drafts[existingIdx], draftData, { savedAt: new Date().toISOString() });
        } else {
            activeDraftId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            drafts.push(Object.assign({ id: activeDraftId, savedAt: new Date().toISOString() }, draftData));
        }

        persistDrafts();
        renderDraftsList();
        setEditingBanner(true);
        document.getElementById('autoGeneratedOrderId').innerText = orderId;

        const label = document.getElementById('saveDraftBtnLabel');
        if (label) {
            const original = label.innerText;
            label.innerText = 'Saved!';
            setTimeout(() => { label.innerText = original; }, 1500);
        }
    }

    function loadDraftIntoForm(id) {
        const draft = drafts.find(d => d.id === id);
        if (!draft) return;

        activeDraftId = draft.id;

        document.getElementById('orderCustInput').value = draft.custInputValue || '';
        document.getElementById('selectedCustId').value = draft.custId || '';
        document.getElementById('selectedCustName').value = draft.custName || '';
        const statusDiv = document.getElementById('custSelectionStatus');
        if (draft.custId && draft.custName) {
            statusDiv.style.display = 'block';
            statusDiv.innerText = `✔ Selected: ${draft.custName} (ID: ${draft.custId})`;
        } else {
            statusDiv.style.display = 'none';
        }

        document.getElementById('orderDateInput').value = draft.orderDate || '';
        document.getElementById('fulfillmentDateInput').value = draft.fulfillmentDate || '';
        document.getElementById('orderDeliveryCharge').value = draft.deliveryCharge || 0;
        document.getElementById('orderDamageCost').value = draft.damageCost || 0;

        sheetOrderCart = (draft.items || []).map(i => Object.assign({}, i));
        renderSheetOrderTable();
        // Show the ID this draft already reserved rather than recalculating —
        // recalculating here could show a different (higher) number if other
        // orders were added since this draft was saved, which would be
        // confusing. The real, collision-safe ID is only computed at submit.
        document.getElementById('autoGeneratedOrderId').innerText = draft.orderId || recalculateAutoOrderId();
        setEditingBanner(true);

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function deleteDraft(id) {
        if (!confirm('Delete this draft? This cannot be undone.')) return;

        drafts = drafts.filter(d => d.id !== id);
        persistDrafts();
        renderDraftsList();

        if (activeDraftId === id) {
            activeDraftId = null;
            setEditingBanner(false);
        }
    }

    function clearOrderForm() {
        activeDraftId = null;
        setEditingBanner(false);

        sheetOrderCart = [];
        document.getElementById('orderCustInput').value = '';
        document.getElementById('selectedCustId').value = '';
        document.getElementById('selectedCustName').value = '';
        document.getElementById('custSelectionStatus').style.display = 'none';
        document.getElementById('orderDeliveryCharge').value = '0';
        document.getElementById('orderDamageCost').value = '0';
        renderSheetOrderTable();
        recalculateAutoOrderId();
    }

    function renderDraftsList() {
        const container = document.getElementById('draftsListContainer');
        const badge = document.getElementById('draftCountBadge');
        if (badge) badge.innerText = `(${drafts.length})`;
        if (!container) return;

        if (!drafts.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No drafts saved yet.</p>';
            return;
        }

        container.innerHTML = drafts.slice().sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')).map(d => {
            const total = draftItemsBilledTotal(d);
            const custLabel = d.custName
                ? d.custName
                : (d.custInputValue ? `⚠️ "${d.custInputValue}" (not matched to a customer)` : '⚠️ No customer selected');

            return `
            <div class="order-card">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
                    <div>
                        <div style="font-weight:800; font-size:0.95rem;">${custLabel}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); font-family:monospace; margin-top:2px;">${d.orderId || 'Preview ID pending'}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">📅 ${d.orderDate || '—'} • ${(d.items||[]).length} item(s) • Saved ${formatSavedAt(d.savedAt)}</div>
                        <div style="font-size:0.85rem; font-weight:700; color:var(--primary-dark); margin-top:6px;">Est. Total: ₹${total.toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                    </div>
                    <div style="display:flex; gap:8px; flex-shrink:0;">
                        <button style="background:var(--primary); color:white; border:none; padding:8px 14px; border-radius:16px; font-weight:700; font-size:0.8rem; cursor:pointer;" onclick="loadDraftIntoForm('${d.id}')">✏️ Edit</button>
                        <button style="background:#fee2e2; color:#b91c1c; border:none; padding:8px 14px; border-radius:16px; font-weight:700; font-size:0.8rem; cursor:pointer;" onclick="deleteDraft('${d.id}')">🗑️ Delete</button>
                    </div>
                </div>
            </div>
            `;
        }).join('');
    }

    function computeItemwiseRequirement() {
        const map = {};
        drafts.forEach(draft => {
            (draft.items || []).forEach(item => {
                const hasSku = item.sku && item.sku !== 'CUSTOM';
                const key = hasSku ? ('sku:' + item.sku) : ('name:' + item.name.toLowerCase());
                if (!map[key]) {
                    map[key] = { sku: hasSku ? item.sku : '', name: item.name, qty: 0, draftIds: new Set() };
                }
                map[key].qty += item.qty;
                map[key].draftIds.add(draft.id);
            });
        });

        return Object.values(map)
            .map(r => ({ sku: r.sku, name: r.name, qty: r.qty, orderCount: r.draftIds.size }))
            .sort((a, b) => b.qty - a.qty);
    }

    function requirementTableHTML(rows) {
        if (!rows.length) {
            return '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px 0;">No saved drafts yet — save a draft first to see aggregated quantities.</p>';
        }
        return `
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
            <thead><tr style="text-align:left; color:var(--text-muted); border-bottom:2px solid var(--border);">
                <th style="padding:8px;">SKU</th><th style="padding:8px;">Item</th><th style="padding:8px; text-align:center;">In Drafts</th><th style="padding:8px; text-align:right;">Total Qty Needed</th>
            </tr></thead>
            <tbody>
            ${rows.map(r => `
                <tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:8px;"><code style="font-size:0.75rem; color:var(--text-muted);">${r.sku || 'N/A'}</code></td>
                    <td style="padding:8px; font-weight:700;">${r.name}</td>
                    <td style="padding:8px; text-align:center;">${r.orderCount}</td>
                    <td style="padding:8px; text-align:right; font-weight:800; color:var(--primary-dark);">${r.qty}</td>
                </tr>
            `).join('')}
            </tbody>
        </table>`;
    }

    function openRequirementModal() {
        const body = document.getElementById('requirementModalBody');
        body.innerHTML = requirementTableHTML(computeItemwiseRequirement());
        document.getElementById('requirementModal').classList.add('active');
    }

    function closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }

    function buildDraftsReportHTML() {
        const now = new Date().toLocaleString('en-IN');
        const requirement = computeItemwiseRequirement();

        const draftSections = drafts.map((d, idx) => {
            const total = draftItemsBilledTotal(d);
            const custLabel = d.custName || (d.custInputValue ? `${d.custInputValue} (unmatched)` : 'No customer selected');
            const itemsRows = (d.items || []).map(i => `
                <tr>
                    <td>${i.sku || 'N/A'}</td>
                    <td>${i.name}</td>
                    <td style="text-align:center;">${i.qty}</td>
                    <td style="text-align:right;">₹${(i.unitPrice||0).toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
                    <td style="text-align:right;">₹${((i.qty||0)*(i.unitPrice||0)).toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
                </tr>
            `).join('');

            return `
            <div class="draft-section">
                <h3>Draft ${idx + 1}: ${custLabel}</h3>
                <div class="meta">Preview ID: ${d.orderId || '—'} (recalculated at submit — may shift) &nbsp;•&nbsp; Order Date: ${d.orderDate || '—'} &nbsp;•&nbsp; Fulfilment: ${d.fulfillmentDate || '—'} &nbsp;•&nbsp; Saved: ${formatSavedAt(d.savedAt)}</div>
                <table>
                    <thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
                    <tbody>${itemsRows}</tbody>
                </table>
                <div class="draft-total">Delivery: ₹${(d.deliveryCharge||0).toLocaleString('en-IN',{maximumFractionDigits:2})} &nbsp;•&nbsp; Est. Total: ₹${total.toLocaleString('en-IN',{maximumFractionDigits:2})}</div>
            </div>
            `;
        }).join('<hr class="section-divider">');

        const requirementRows = requirement.map(r => `
            <tr>
                <td>${r.sku || 'N/A'}</td>
                <td>${r.name}</td>
                <td style="text-align:center;">${r.orderCount}</td>
                <td style="text-align:right; font-weight:700;">${r.qty}</td>
            </tr>
        `).join('');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Go-Kirana — Draft Orders Report</title>
<style>
    body { font-family: -apple-system, Arial, sans-serif; color:#0f172a; padding: 24px; max-width: 820px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin-bottom: 2px; }
    .generated { color:#64748b; font-size:0.8rem; margin-bottom: 24px; }
    h2 { font-size: 1.1rem; margin-top: 32px; border-bottom: 2px solid #10b981; padding-bottom: 6px; }
    h3 { font-size: 1rem; margin-bottom: 2px; }
    .meta { color:#64748b; font-size:0.8rem; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 6px; }
    th { text-align:left; background:#f1f5f9; padding: 6px 8px; font-size: 0.75rem; text-transform:uppercase; color:#64748b; }
    td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
    .draft-total { text-align:right; font-weight: 700; font-size: 0.85rem; margin-bottom: 4px; }
    .section-divider { border:none; border-top: 1px dashed #cbd5e1; margin: 20px 0; }
    .no-print { margin-top: 24px; }
    @media print { .no-print { display:none; } }
</style>
</head>
<body>
    <h1>🏪 Go-Kirana — Draft Orders Report</h1>
    <div class="generated">Generated ${now} &nbsp;•&nbsp; ${drafts.length} draft order(s)</div>

    ${drafts.length ? draftSections : '<p>No saved drafts.</p>'}

    <h2>📦 Total Item-wise Requirement</h2>
    <table>
        <thead><tr><th>SKU</th><th>Item</th><th>In Drafts</th><th>Total Qty</th></tr></thead>
        <tbody>${requirementRows || '<tr><td colspan="4">No items.</td></tr>'}</tbody>
    </table>

    <div class="no-print">
        <button onclick="window.print()" style="background:#10b981;color:white;border:none;padding:10px 18px;border-radius:20px;font-weight:700;cursor:pointer;">🖨️ Print / Save as PDF</button>
    </div>
</body>
</html>`;
    }

    function exportDraftsReport() {
        if (!drafts.length) {
            alert('No saved drafts to export yet.');
            return;
        }
        const html = buildDraftsReportHTML();
        const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const win = window.open(blobUrl, '_blank');
        if (!win) {
            alert('⚠️ Please allow popups to export the report.');
            return;
        }
        // Give the new tab time to actually load the blob before revoking it.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    function initView(force) {
        const today = new Date().toISOString().substring(0, 10);
        document.getElementById('orderDateInput').value = today;
        document.getElementById('fulfillmentDateInput').value = today;
        loadDraftsFromStorage();
        renderDraftsList();
        fetchLiveData(force);
    }

    Object.assign(window, {
        onCustomerSelected,
        recalculateAutoOrderId,
        adjustSearchQty,
        addSelectedProductToTable,
        handleSearchSuggestInput,
        selectSuggestedProduct,
        updateSheetOrderItemQty,
        updateSheetOrderItemUnitPrice,
        updateSheetOrderItemCostPrice,
        removeSheetOrderItem,
        renderSheetOrderSummary,
        submitOrderToGoogleSheet,
        saveDraft,
        loadDraftIntoForm,
        deleteDraft,
        clearOrderForm,
        openRequirementModal,
        closeModal,
        exportDraftsReport
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call initView() here, or every navigation double-fetches.
    window.GK_viewInit = () => initView(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
