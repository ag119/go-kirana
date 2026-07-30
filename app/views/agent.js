/* Go-Kirana — Agent Hub view. Loaded fresh by the shell router on every
   navigation to #/agent, so it's safe to keep this as a plain IIFE with
   top-level state — nothing here leaks unless explicitly attached to
   window below. */
(function () {
    'use strict';

    const WHATSAPP_NUM = '917678153075';

    let rawCustomers = [];
    let rawOrders = [];
    let rawOrderItems = [];
    let rawProducts = [];

    let productMapBySKU = {};
    let productMapByNameAndPrice = {};

    let processedCustomers = [];
    let activeOrderCustomer = null;
    let cartItems = [];
    let newOrderCartItems = [];

    // --- DATA FETCHING (via Apps Script proxy — no sheet ID/gviz here) ---
    // force=true bypasses the shared localStorage cache (see app/assets/api.js) —
    // used by the shell's Refresh button. Plain navigation reuses cached data.
    async function fetchLiveData(force) {
        const status = document.getElementById('status-banner');
        status.className = 'status-loading';
        status.innerHTML = '📡 Syncing real-time store data...';

        try {
            const [cust, ord, items, prods] = await Promise.all([
                GK.api.getSheet('Customers', { force }),
                GK.api.getSheet('Orders', { force }),
                GK.api.getSheet('Order Details', { force }),
                GK.api.getSheet('Products', { force })
            ]);

            rawCustomers = cust;
            rawOrders = ord;
            rawOrderItems = items;
            rawProducts = prods;

            productMapBySKU = {};
            productMapByNameAndPrice = {};

            prods.forEach(p => {
                const sku = (p['SKU'] || '').trim();
                const name = p['Item Name'] || p['Standard Name'] || sku;
                const price = parseFloat(p['Price per Unit'] || 0);
                const costPrice = parseFloat(p['Cost Price'] || p['Cost'] || p['Purchase Price'] || 0);

                if (sku) {
                    productMapBySKU[sku] = { sku, name, price, costPrice };
                    const suggestionLabel = `${name} - ₹${price}`;
                    productMapByNameAndPrice[suggestionLabel.toLowerCase()] = { sku, name, price, costPrice };
                }
            });

            processCustomerScoresAndRanks();
            renderCustomersGrid(processedCustomers);
            renderFollowupGrid();
            renderPriceList(rawProducts);
            renderOrdersStream(rawOrders);

            status.className = 'status-success';
            status.innerHTML = `✅ Store synced live at ${new Date().toLocaleTimeString()}`;
        } catch (err) {
            console.error(err);
            status.className = 'status-error';
            status.innerHTML = '⚠️ Connectivity issue fetching Google Sheet.';
        }
    }

    function processCustomerScoresAndRanks() {
        let maxRevenue = 1;
        rawCustomers.forEach(c => {
            const amt = parseFloat(String(c['Total Amount']||0).replace(/[^0-9.-]+/g,"")) || 0;
            if (amt > maxRevenue) maxRevenue = amt;
        });

        processedCustomers = rawCustomers.map(c => {
            const totalAmt = parseFloat(String(c['Total Amount']||0).replace(/[^0-9.-]+/g,"")) || 0;
            const totalOrds = parseFloat(c['Total Orders']||0) || 0;
            const aov = parseFloat(String(c['AOV(Average Order Value)']||0).replace(/[^0-9.-]+/g,"")) || 0;
            const weeklyFreq = parseFloat(c['Order Frequency (Per Week)']||0) || 0;
            const daysSince = parseFloat(c['Days Since Last Order']||0) || 0;

            const revenueScore = (totalAmt / maxRevenue) * 40;
            const freqScore = Math.min((weeklyFreq / 2.0) * 30, 30);
            const targetIntervalDays = weeklyFreq > 1.0 ? (7 / weeklyFreq) : 7;
            let recencyScore = 30 - Math.max(0, (daysSince - targetIntervalDays) * 3);
            recencyScore = Math.max(0, recencyScore);

            const finalScore = Math.round(revenueScore + freqScore + recencyScore);
            const isFollowupDue = daysSince >= targetIntervalDays;

            return {
                ...c,
                score: finalScore,
                totalAmt,
                totalOrds,
                aov,
                weeklyFreq,
                daysSince,
                targetIntervalDays: Math.round(targetIntervalDays),
                isFollowupDue
            };
        });

        processedCustomers.sort((a, b) => b.score - a.score);
        processedCustomers.forEach((c, index) => c.rank = index + 1);
    }

    function renderCustomersGrid(data) {
        const grid = document.getElementById('customersGrid');
        document.getElementById('custCount').innerText = `${data.length} Customers`;

        grid.innerHTML = data.map(c => {
            const initials = (c['Owner Name'] || 'C').split(' ').map(n=>n[0]).join('').substring(0,2);
            const custId = c['Id'] || c['ID'];

            return `
            <div class="customer-card">
                <div class="rank-badge">Rank #${c.rank}</div>
                <div onclick="openCustomerDetails('${custId}', '${c['Owner Name']}')">
                    <div class="card-header-user">
                        <div class="avatar">${initials}</div>
                        <div class="user-info">
                            <h3>${c['Owner Name']}</h3>
                            <p>📱 +${c['Country Code']||'91'} ${c['Mobile Number']||''}</p>
                        </div>
                    </div>

                    <div class="score-pill-row">
                        <span style="font-size:0.8rem; font-weight:700; color:var(--text-muted);">Customer Score</span>
                        <span class="score-val">⭐ ${c.score} / 100</span>
                    </div>

                    <div class="stats-badge-row">
                        <span class="badge green">📦 ${c.totalOrds} Orders</span>
                        <span class="badge">⚡ ${c.weeklyFreq.toFixed(1)}/wk</span>
                        <span class="badge ${c.isFollowupDue ? 'red' : 'orange'}">⌛ ${c.daysSince} days ago</span>
                    </div>

                    <div class="card-metrics">
                        <div class="metric-item">
                            <span>Total Spent</span>
                            <strong>₹${c.totalAmt.toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>
                        </div>
                        <div class="metric-item">
                            <span>Avg Order (AOV)</span>
                            <strong>₹${c.aov.toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>
                        </div>
                    </div>
                </div>

                <div class="card-footer-action">
                    <button class="btn-analytics" onclick="openDeepAnalytics('${custId}', '${c['Owner Name']}')">📊 Analytics</button>
                    <button class="btn-order" onclick="openOrderForm('${custId}', '${c['Owner Name']}', '${c['Mobile Number']}')">📝 Take Order</button>
                </div>
            </div>
            `;
        }).join('');
    }

    function renderFollowupGrid() {
        const grid = document.getElementById('followupGrid');
        const dueList = processedCustomers.filter(c => c.isFollowupDue);

        if (!dueList.length) {
            grid.innerHTML = '<p style="padding:20px; color:var(--text-muted);">🎉 All shopkeepers up-to-date!</p>';
            return;
        }

        grid.innerHTML = dueList.map(c => {
            const initials = (c['Owner Name'] || 'C').split(' ').map(n=>n[0]).join('').substring(0,2);
            const custId = c['Id'] || c['ID'];

            return `
            <div class="customer-card" style="border-left:4px solid var(--accent-red);">
                <div class="rank-badge" style="background:#ef4444;">Rank #${c.rank}</div>
                <div onclick="openCustomerDetails('${custId}', '${c['Owner Name']}')">
                    <div class="card-header-user">
                        <div class="avatar" style="background:#fee2e2; color:#b91c1c;">${initials}</div>
                        <div class="user-info">
                            <h3>${c['Owner Name']}</h3>
                            <p>📱 +${c['Country Code']||'91'} ${c['Mobile Number']||''}</p>
                        </div>
                    </div>

                    <div class="stats-badge-row">
                        <span class="badge red">⚠️ Overdue by ${c.daysSince - c.targetIntervalDays} days</span>
                        <span class="badge">Target: Every ${c.targetIntervalDays} days</span>
                    </div>
                </div>

                <div class="card-footer-action">
                    <button class="btn-order" style="background:#ef4444; width:100%;" onclick="openOrderForm('${custId}', '${c['Owner Name']}', '${c['Mobile Number']}')">📝 Take Order & Send WhatsApp</button>
                </div>
            </div>
            `;
        }).join('');
    }

    // --- RELEVANCE SEARCH & FUZZY MATCHING HELPERS ---
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

    function adjustBuilderQty(inputId, delta) {
        const input = document.getElementById(inputId);
        if (!input) return;
        let val = parseInt(input.value) || 1;
        val += delta;
        if (val < 1) val = 1;
        input.value = val;
    }

    function filterPriceList() {
        const q = document.getElementById('priceSearch').value.trim();

        if (!q) {
            renderPriceList(rawProducts);
            return;
        }

        const scoredProducts = rawProducts
            .map(p => ({ product: p, score: getMatchScore(p, q) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(item => item.product);

        renderPriceList(scoredProducts);
    }

    function renderPriceList(prods) {
        const container = document.getElementById('priceListCardsContainer');
        document.getElementById('priceItemCount').innerText = `${prods.length} Items`;

        if (!prods.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No products found matching search.</p>';
            return;
        }

        container.innerHTML = prods.map(p => {
            const name = p['Item Name'] || p['Standard Name'] || p['SKU'] || '';
            const price = p['Price per Unit'] || '0';

            return `
            <div class="price-card">
                <div class="price-card-info">
                    <div class="price-card-name">${name}</div>
                </div>

                <div class="price-card-actions">
                    <div class="price-card-val">₹${price.toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                </div>
            </div>
            `;
        }).join('');
    }

    function openCustomerDetails(custId, custName) {
        document.getElementById('modalCustName').innerText = custName;
        document.getElementById('modalCustMeta').innerText = `Customer ID: ${custId}`;

        const custOrders = rawOrders.filter(o => (o['CustomerId'] || '').trim() === custId.trim() || (o['CustomerName']||'').toLowerCase() === custName.toLowerCase());
        const totalCustOrders = custOrders.length;

        const itemStats = {};

        custOrders.forEach((o, orderIndex) => {
            const orderId = o['Id'] || o['Order ID'];
            const items = rawOrderItems.filter(i => (i['Order ID'] || i['Id'] || '').trim() === orderId.trim());

            items.forEach(i => {
                const sku = (i['SKU'] || '').trim();
                const prod = productMapBySKU[sku];
                const itemName = prod ? prod.name : sku;

                if (!itemStats[itemName]) {
                    itemStats[itemName] = { totalQty: 0, orderAppearances: 0, lastOrderIndex: orderIndex };
                }

                itemStats[itemName].totalQty += (parseInt(i['Quantity']) || 1);
                itemStats[itemName].orderAppearances += 1;
                itemStats[itemName].lastOrderIndex = orderIndex;
            });
        });

        const rankedRecommendations = Object.keys(itemStats).map(name => {
            const stat = itemStats[name];
            const orderRatio = totalCustOrders > 0 ? (stat.orderAppearances / totalCustOrders) : 0;

            let probability = Math.round(orderRatio * 100);
            if (probability > 95) probability = 95;
            if (probability < 15) probability = 15;

            return { name, totalQty: stat.totalQty, probability, score: probability * stat.totalQty };
        }).sort((a, b) => b.score - a.score).slice(0, 6);

        const recChipsContainer = document.getElementById('modalRecChips');
        recChipsContainer.innerHTML = rankedRecommendations.length ?
            rankedRecommendations.map(item => `
                <div class="rec-chip">
                    <span>📦 ${item.name} (${item.totalQty}x)</span>
                    <span class="prob-badge">${item.probability}% Need</span>
                </div>
            `).join('') :
            '<span style="font-size:0.8rem; color:var(--text-muted);">No order history available.</span>';

        const body = document.getElementById('modalOrdersBody');
        body.innerHTML = custOrders.map(o => {
            const orderId = o['Id'] || o['Order ID'];
            const billAmt = parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            const profitAmt = parseFloat(String(o['Profit/Loss'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            const profitPct = billAmt ? ((profitAmt / billAmt) * 100).toFixed(2) : '0.00';

            const items = rawOrderItems.filter(i => (i['Order ID'] || i['Id'] || '').trim() === orderId.trim());

            return `
            <div class="order-card">
                <div class="order-card-header" onclick="toggleOrderItems('${orderId}')">
                    <div>
                        <div class="order-id">${orderId}</div>
                        <div class="order-date">📅 ${o['Order Date']} • ${items.length} items</div>
                        <div class="profit-badge ${profitAmt >= 0 ? 'profit-pos' : 'profit-neg'}">
                            Profit: ₹${profitAmt.toLocaleString('en-IN', {maximumFractionDigits:2})} (${profitPct}%)
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:800; font-size:1rem;">₹${billAmt.toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                        <div style="font-size:0.75rem; color:var(--primary-dark); font-weight:700;">Items ▼</div>
                    </div>
                </div>

                <div class="order-items-list" id="items-${orderId}">
                    ${items.map(i => {
                        const sku = (i['SKU'] || '').trim();
                        const prod = productMapBySKU[sku];
                        const descriptiveName = prod ? prod.name : sku;
                        return `
                        <div class="item-row">
                            <div>
                                <div class="item-name">${descriptiveName}</div>
                                <div class="item-meta">Qty: ${i['Quantity']} • Unit Price: ₹${(parseFloat(i['Unit Price']) || 0).toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                            </div>
                            <strong>₹${parseFloat(String(i['Calculated Total']||0).replace(/[^0-9.-]+/g,"")).toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>
                        </div>
                        `;
                    }).join('')}
                </div>
            </div>
            `;
        }).join('');

        document.getElementById('detailsModal').classList.add('active');
    }

    function openDeepAnalytics(custId, custName) {
        document.getElementById('analyticsCustName').innerText = custName;

        const custOrders = rawOrders.filter(o => (o['CustomerId'] || '').trim() === custId.trim() || (o['CustomerName']||'').toLowerCase() === custName.toLowerCase());

        let totalRev = 0, totalProfit = 0;
        custOrders.forEach(o => {
            totalRev += parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            totalProfit += parseFloat(String(o['Profit/Loss'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
        });

        const marginPct = totalRev ? ((totalProfit / totalRev) * 100).toFixed(2) : '0.00';
        const avgProfit = custOrders.length ? (totalProfit / custOrders.length).toFixed(2) : '0';

        document.getElementById('anTotalRev').innerText = `₹${totalRev.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
        document.getElementById('anNetProfit').innerText = `₹${totalProfit.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
        document.getElementById('anProfitMargin').innerText = `${marginPct}%`;
        document.getElementById('anAvgProfit').innerText = `₹${avgProfit}`;

        document.getElementById('analyticsOrdersList').innerHTML = custOrders.map(o => {
            const bill = parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            const profit = parseFloat(String(o['Profit/Loss'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            const pct = bill ? ((profit / bill) * 100).toFixed(2) : '0.00';

            return `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <span>📅 ${o['Order Date']} (${o['Id'] || o['Order ID']})</span>
                <strong>₹${bill.toLocaleString('en-IN', {maximumFractionDigits:2})} | Profit: <span style="color:#10b981;">₹${profit.toLocaleString('en-IN', {maximumFractionDigits:2})} (${pct}%)</span></strong>
            </div>
            `;
        }).join('');

        document.getElementById('analyticsModal').classList.add('active');
    }

    function openOrderForm(custId, custName, mobile) {
        activeOrderCustomer = { custId, custName, mobile };
        cartItems = [];
        document.getElementById('orderFormCustMeta').innerText = `${custName} (📱 +91 ${mobile})`;
        renderCart();
        document.getElementById('orderFormModal').classList.add('active');
    }

    function addOrderItem() {
        const inputVal = document.getElementById('builderItemName').value.trim();
        const qty = parseInt(document.getElementById('builderQty').value) || 1;

        if (!inputVal) return;

        const matched = findBestProductMatch(inputVal);

        if (matched) {
            cartItems.push({
                sku: matched.sku,
                name: matched.name,
                qty: qty,
                unitPrice: matched.price,
                costPrice: matched.costPrice || 0
            });
        } else {
            cartItems.push({
                sku: null,
                name: inputVal,
                qty: qty,
                unitPrice: null,
                costPrice: 0
            });
        }

        document.getElementById('builderItemName').value = '';
        document.getElementById('builderQty').value = '1';
        document.getElementById('builderDropdown').style.display = 'none';
        renderCart();
    }

    function renderCart() {
        const container = document.getElementById('cartItemsList');
        let estTotal = 0;

        if (!cartItems.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No items added yet.</p>';
            document.getElementById('cartEstimatedTotal').innerText = '₹0';
            return;
        }

        container.innerHTML = cartItems.map((item, idx) => {
            const itemTotal = item.unitPrice ? (item.unitPrice * item.qty) : 0;
            estTotal += itemTotal;

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <div>
                    <strong>${item.name}</strong> × ${item.qty}
                    <div style="font-size:0.75rem; color:var(--text-muted);">${item.unitPrice ? `₹${item.unitPrice.toLocaleString('en-IN', {maximumFractionDigits:2})}/unit` : 'Price on request'}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <strong>${item.unitPrice ? `₹${itemTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}` : 'N/A'}</strong>
                    <button onclick="removeCartItem(${idx})" style="border:none; background:none; color:red; cursor:pointer;">✕</button>
                </div>
            </div>
            `;
        }).join('');

        document.getElementById('cartEstimatedTotal').innerText = `₹${estTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
    }

    function removeCartItem(idx) {
        cartItems.splice(idx, 1);
        renderCart();
    }

    function buildWhatsAppOrderMessage(title, name, mobile, items) {
        let message = `${title}\n\n`;
        message += `👤 *Shopkeeper:* ${name}\n`;
        message += `📱 *Mobile:* +91 ${mobile}\n\n`;
        message += `📦 *Order Items:*\n`;

        let approxTotal = 0;
        let approxCostTotal = 0;

        items.forEach((item, index) => {
            if (item.unitPrice) {
                const itemTotal = item.unitPrice * item.qty;
                approxTotal += itemTotal;
                if (item.costPrice) approxCostTotal += item.costPrice * item.qty;
                message += `${index + 1}. ${item.name} (Qty: ${item.qty}) - ₹${item.unitPrice.toLocaleString('en-IN', {maximumFractionDigits:2})} = ₹${itemTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}\n`;
            } else {
                message += `${index + 1}. ${item.name} (Qty: ${item.qty}) - Price N/A\n`;
            }
        });

        message += `\n💰 *Approx Total Amount:* ₹${approxTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}`;

        const approxProfit = approxTotal - approxCostTotal;
        if (approxTotal > 0 && approxCostTotal > 0) {
            const marginPct = ((approxProfit / approxTotal) * 100).toFixed(2);
            message += `\n📈 *Est. Profit:* ₹${approxProfit.toLocaleString('en-IN', {maximumFractionDigits:2})} (${marginPct}%)`;
        }

        return message;
    }

    function sendOrderToWhatsApp() {
        if (!activeOrderCustomer || !cartItems.length) {
            alert('Please add at least one item to the order.');
            return;
        }

        const message = buildWhatsAppOrderMessage('🛒 *NEW ORDER - GO-KIRANA*', activeOrderCustomer.custName, activeOrderCustomer.mobile, cartItems);
        const waUrl = `https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank');
    }

    // --- NEW ORDER TAB LOGIC (UNREGISTERED CUSTOMER) ---
    function addNewOrderItem() {
        const inputVal = document.getElementById('newOrderBuilderItemName').value.trim();
        const qty = parseInt(document.getElementById('newOrderBuilderQty').value) || 1;

        if (!inputVal) return;

        const matched = findBestProductMatch(inputVal);

        if (matched) {
            newOrderCartItems.push({
                sku: matched.sku,
                name: matched.name,
                qty: qty,
                unitPrice: matched.price,
                costPrice: matched.costPrice || 0
            });
        } else {
            newOrderCartItems.push({
                sku: null,
                name: inputVal,
                qty: qty,
                unitPrice: null,
                costPrice: 0
            });
        }

        document.getElementById('newOrderBuilderItemName').value = '';
        document.getElementById('newOrderBuilderQty').value = '1';
        document.getElementById('newOrderDropdown').style.display = 'none';
        renderNewOrderCart();
    }

    function renderNewOrderCart() {
        const container = document.getElementById('newOrderCartItemsList');
        let estTotal = 0;

        if (!newOrderCartItems.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No items added yet.</p>';
            document.getElementById('newOrderCartEstimatedTotal').innerText = '₹0';
            return;
        }

        container.innerHTML = newOrderCartItems.map((item, idx) => {
            const itemTotal = item.unitPrice ? (item.unitPrice * item.qty) : 0;
            estTotal += itemTotal;

            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <div>
                    <strong>${item.name}</strong> × ${item.qty}
                    <div style="font-size:0.75rem; color:var(--text-muted);">${item.unitPrice ? `₹${item.unitPrice.toLocaleString('en-IN', {maximumFractionDigits:2})}/unit` : 'Price on request'}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <strong>${item.unitPrice ? `₹${itemTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}` : 'N/A'}</strong>
                    <button onclick="removeNewOrderCartItem(${idx})" style="border:none; background:none; color:red; cursor:pointer;">✕</button>
                </div>
            </div>
            `;
        }).join('');

        document.getElementById('newOrderCartEstimatedTotal').innerText = `₹${estTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
    }

    function removeNewOrderCartItem(idx) {
        newOrderCartItems.splice(idx, 1);
        renderNewOrderCart();
    }

    function sendNewCustomerOrderToWhatsApp() {
        const name = document.getElementById('newCustName').value.trim();
        const mobile = document.getElementById('newCustMobile').value.trim();

        if (!name) {
            alert('Please enter the Shopkeeper Name.');
            document.getElementById('newCustName').focus();
            return;
        }
        if (!mobile) {
            alert('Please enter the Mobile Number.');
            document.getElementById('newCustMobile').focus();
            return;
        }
        if (!newOrderCartItems.length) {
            alert('Please add at least one item to the cart.');
            return;
        }

        const message = buildWhatsAppOrderMessage('✨ *NEW CUSTOMER ORDER - GO-KIRANA*', name, mobile, newOrderCartItems);
        const waUrl = `https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank');
    }

    function toggleOrderItems(orderId) {
        const list = document.getElementById(`items-${orderId}`);
        if (list) list.classList.toggle('open');
    }

    function closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }

    function filterCustomers() {
        const q = document.getElementById('custSearch').value.toLowerCase();
        const filtered = processedCustomers.filter(c => (c['Owner Name']||'').toLowerCase().includes(q) || (c['Mobile Number']||'').includes(q));
        renderCustomersGrid(filtered);
    }

    function filterOrders() {
        const q = document.getElementById('orderSearch').value.toLowerCase();
        const filtered = rawOrders.filter(o => (o['Id']||'').toLowerCase().includes(q) || (o['CustomerName']||'').toLowerCase().includes(q));
        renderOrdersStream(filtered);
    }

    function renderOrdersStream(orders) {
        const stream = document.getElementById('ordersListStream');
        stream.innerHTML = orders.map(o => `
            <div class="order-card">
                <div class="order-card-header">
                    <div>
                        <div class="order-id">${o['Id'] || o['Order ID']}</div>
                        <div class="order-date">👤 <strong>${o['CustomerName']||'Customer'}</strong> • 📅 ${o['Order Date']}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:800; font-size:1.05rem;">₹${parseFloat(String(o['Bill Amout']||o['Bill Amount']||0).replace(/[^0-9.-]+/g,"")).toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                        <span class="profit-badge profit-pos">Profit: ₹${(parseFloat(o['Profit/Loss']) || 0).toLocaleString('en-IN', {maximumFractionDigits:2})}</span>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.pill-btn').forEach(el => el.classList.remove('active'));

        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        const buttons = document.querySelectorAll('#mainNavPills .pill-btn');
        buttons.forEach(btn => {
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(tabId)) {
                btn.classList.add('active');
            }
        });
    }

    // Expose only what the inline HTML handlers (onclick/onchange/...) need.
    Object.assign(window, {
        fetchLiveData,
        switchTab,
        filterCustomers,
        filterOrders,
        filterPriceList,
        handleSearchSuggestInput,
        selectSuggestedProduct,
        adjustBuilderQty,
        openCustomerDetails,
        openDeepAnalytics,
        openOrderForm,
        addOrderItem,
        removeCartItem,
        sendOrderToWhatsApp,
        addNewOrderItem,
        removeNewOrderCartItem,
        sendNewCustomerOrderToWhatsApp,
        toggleOrderItems,
        closeModal
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call fetchLiveData() here, or every navigation double-fetches.
    window.GK_viewInit = () => fetchLiveData(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
