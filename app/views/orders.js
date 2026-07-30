/* Go-Kirana — Record Order view (desktop order & line-item logger).
   Loaded fresh by the shell router on every navigation to #/orders. */
(function () {
    'use strict';

    let rawCustomers = [];
    let rawOrders = [];
    let rawProducts = [];
    let sheetOrderCart = [];

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

    function recalculateAutoOrderId() {
        const dateInput = document.getElementById('orderDateInput');
        let dateVal = dateInput.value;
        if (!dateVal) {
            dateVal = new Date().toISOString().substring(0, 10);
            dateInput.value = dateVal;
        }

        const yyyymmdd = dateVal.replace(/-/g, '');
        const prefix = 'GKO' + yyyymmdd;
        let maxSeq = 0;

        rawOrders.forEach(o => {
            const oId = String(o['Id'] || o['Order ID'] || '').trim();
            if (oId.startsWith(prefix)) {
                const seqPart = oId.substring(prefix.length);
                const seqNum = parseInt(seqPart, 10);
                if (!isNaN(seqNum) && seqNum > maxSeq) maxSeq = seqNum;
            }
        });

        const nextSeq = maxSeq + 1;
        const formattedSeq = String(nextSeq).padStart(8, '0');
        const autoId = prefix + formattedSeq;

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

        const autoId = recalculateAutoOrderId();
        const delCharge = parseFloat(document.getElementById('orderDeliveryCharge').value) || 0;
        const damageCost = parseFloat(document.getElementById('orderDamageCost').value) || 0;

        const btn = document.getElementById('btnSubmitSheetOrder');
        btn.disabled = true;
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

            sheetOrderCart = [];
            document.getElementById('orderCustInput').value = '';
            document.getElementById('selectedCustId').value = '';
            document.getElementById('selectedCustName').value = '';
            document.getElementById('custSelectionStatus').style.display = 'none';
            document.getElementById('orderDeliveryCharge').value = '0';
            document.getElementById('orderDamageCost').value = '0';
            renderSheetOrderTable();

            fetchLiveData(true);
        } catch (err) {
            console.error(err);
            alert(`⚠️ Error submitting order: ${err.message || 'Unknown error'}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '🚀 Submit Order to Google Sheet';
        }
    }

    function initView(force) {
        const today = new Date().toISOString().substring(0, 10);
        document.getElementById('orderDateInput').value = today;
        document.getElementById('fulfillmentDateInput').value = today;
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
        submitOrderToGoogleSheet
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call initView() here, or every navigation double-fetches.
    window.GK_viewInit = () => initView(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
