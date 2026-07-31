/* Go-Kirana — Admin view (Store Analytics, Shop Insights, Inventory Guide
   + everything in Agent Hub). Loaded fresh by the shell router on every
   navigation to #/admin. */
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
    let chartInstance = null;
    let chartJsLoadPromise = null;

    function loadChartJs() {
        if (window.Chart) return Promise.resolve();
        if (chartJsLoadPromise) return chartJsLoadPromise;
        chartJsLoadPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
        return chartJsLoadPromise;
    }

    // --- DATA FETCHING (via Apps Script proxy — no sheet ID/gviz here) ---
    // force=true bypasses the shared localStorage cache (see app/assets/api.js) —
    // used by the shell's Refresh button. Plain navigation reuses cached data.
    async function fetchLiveData(force) {
        const status = document.getElementById('status-banner');
        status.className = 'status-loading';
        status.innerHTML = '📡 Syncing real-time store data...';

        try {
            await loadChartJs();

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
            renderStoreAnalyticsDashboard();
            renderCustomersGrid(processedCustomers);
            renderFollowupGrid();
            renderPriceList(rawProducts);
            renderOrdersStream(rawOrders);
            buildInsightIndex();
            renderShopInsightSelect();
            renderInventoryGuide();
            initDayWiseBillsTab();

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

    function renderStoreAnalyticsDashboard() {
        let totalRevenue = 0, totalProfit = 0, monthlySales = {};
        let dayOrders = 0, daySales = 0, dayProfit = 0;
        let monthOrders = 0, monthSales = 0, monthProfit = 0;

        const now = new Date();
        const todayStr = now.toISOString().substring(0, 10);
        const thisMonthStr = now.toISOString().substring(0, 7);

        rawOrders.forEach(o => {
            const bill = parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || '0').replace(/[^0-9.-]+/g,"")) || 0;
            const profit = parseFloat(String(o['Profit/Loss'] || '0').replace(/[^0-9.-]+/g,"")) || 0;

            totalRevenue += bill;
            totalProfit += profit;

            const dateStr = String(o['Order Date'] || '');
            if (dateStr.length >= 7) {
                const m = dateStr.substring(0, 7);
                monthlySales[m] = (monthlySales[m] || 0) + bill;

                if (m === thisMonthStr) {
                    monthOrders++;
                    monthSales += bill;
                    monthProfit += profit;
                }
            }
            if (dateStr.length >= 10 && dateStr.substring(0, 10) === todayStr) {
                dayOrders++;
                daySales += bill;
                dayProfit += profit;
            }
        });

        document.getElementById('kpi-day-orders').innerText = dayOrders;
        document.getElementById('kpi-day-sales').innerText = `₹${daySales.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
        document.getElementById('kpi-day-profit').innerText = `₹${dayProfit.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

        document.getElementById('kpi-month-orders').innerText = monthOrders;
        document.getElementById('kpi-month-sales').innerText = `₹${monthSales.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
        document.getElementById('kpi-month-profit').innerText = `₹${monthProfit.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

        document.getElementById('kpi-revenue').innerText = `₹${totalRevenue.toLocaleString('en-IN', {maximumFractionDigits:2})}`;
        document.getElementById('kpi-orders').innerText = rawOrders.length;
        document.getElementById('kpi-profit').innerText = `₹${totalProfit.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        document.getElementById('kpi-aov').innerText = rawOrders.length ? `₹${Math.round(totalRevenue / rawOrders.length).toLocaleString('en-IN', {maximumFractionDigits:2})}` : '₹0';

        const months = Object.keys(monthlySales).sort();
        const revs = months.map(m => monthlySales[m]);

        if (!window.Chart) return;
        if (chartInstance) chartInstance.destroy();
        const canvas = document.getElementById('monthlyChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months,
                datasets: [{
                    label: 'Sales Revenue (₹)',
                    data: revs,
                    backgroundColor: '#10b981',
                    borderRadius: 8
                }]
            },
            options: { responsive: true }
        });
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

    // --- RELEVANCE SEARCH & FUZZY MATCHING (shared with Agent Hub, same engine) ---
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
                    matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
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
                if (levenshteinDistance(word, query) <= 2) return true;
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
        let bestProduct = null, highestScore = 0;
        const cleanQuery = query.trim();

        rawProducts.forEach(p => {
            const score = getMatchScore(p, cleanQuery);
            if (score > highestScore) { highestScore = score; bestProduct = p; }
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
        if (!query) { dropdown.style.display = 'none'; return; }

        const scoredMatches = rawProducts
            .map(p => ({ product: p, score: getMatchScore(p, query) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

        if (!scoredMatches.length) { dropdown.style.display = 'none'; return; }

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
        if (!q) { renderPriceList(rawProducts); return; }

        const scoredProducts = rawProducts
            .map(p => ({ product: p, score: getMatchScore(p, q) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(item => item.product);

        renderPriceList(scoredProducts);
    }

    // Double-tap/double-click a price card to reveal cost price + margin —
    // a quick "what's my real margin here" check without opening the sheet.
    // Native dblclick is unreliable on touch (can conflict with pinch-zoom),
    // so this does its own tap-timing detection and works for both.
    let lastPriceTap = { sku: null, time: 0 };
    function handlePriceCardTap(sku) {
        const now = Date.now();
        if (lastPriceTap.sku === sku && (now - lastPriceTap.time) < 350) {
            toggleCostPrice(sku);
            lastPriceTap = { sku: null, time: 0 };
        } else {
            lastPriceTap = { sku, time: now };
        }
    }

    function toggleCostPrice(sku) {
        const row = document.getElementById(`cost-${sku}`);
        if (row) row.style.display = row.style.display === 'none' ? 'block' : 'none';
    }

    function renderPriceList(prods) {
        const container = document.getElementById('priceListCardsContainer');
        document.getElementById('priceItemCount').innerText = `${prods.length} Items`;

        if (!prods.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No products found matching search.</p>';
            return;
        }

        container.innerHTML = prods.map(p => {
            const sku = (p['SKU'] || '').trim();
            const name = p['Item Name'] || p['Standard Name'] || sku || '';
            const price = parseFloat(p['Price per Unit'] || 0);
            const costPrice = (sku && productMapBySKU[sku]) ? productMapBySKU[sku].costPrice : 0;
            const marginAmt = price - costPrice;
            const marginPct = price > 0 ? ((marginAmt / price) * 100).toFixed(1) : '0.0';

            return `
            <div class="price-card" onclick="handlePriceCardTap('${sku}')" style="cursor:pointer;">
                <div class="price-card-info">
                    <div class="price-card-name">${name}</div>
                    <div id="cost-${sku}" style="display:none; font-size:0.78rem; color:var(--text-muted); margin-top:4px;">
                        Cost: ₹${costPrice.toLocaleString('en-IN', {maximumFractionDigits:2})} &nbsp;•&nbsp; Margin: ₹${marginAmt.toLocaleString('en-IN', {maximumFractionDigits:2})} (${marginPct}%)
                    </div>
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

        const custOrders = sortOrdersDesc(rawOrders.filter(o => (o['CustomerId'] || '').trim() === custId.trim() || (o['CustomerName']||'').toLowerCase() === custName.toLowerCase()));
        const totalCustOrders = custOrders.length;
        const itemStats = {};

        custOrders.forEach((o, orderIndex) => {
            const orderId = o['Id'] || o['Order ID'];
            const items = rawOrderItems.filter(i => (i['Order ID'] || i['Id'] || '').trim() === orderId.trim());

            items.forEach(i => {
                const sku = (i['SKU'] || '').trim();
                const prod = productMapBySKU[sku];
                const itemName = prod ? prod.name : sku;

                if (!itemStats[itemName]) itemStats[itemName] = { totalQty: 0, orderAppearances: 0, lastOrderIndex: orderIndex };
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
        body.innerHTML = withMonthDividers(custOrders, o => {
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
                        <div class="order-date">📅 ${normalizeSheetDate(o['Order Date'])} • ${items.length} items</div>
                        <div class="profit-badge ${profitAmt >= 0 ? 'profit-pos' : 'profit-neg'}">Profit: ₹${profitAmt.toLocaleString('en-IN', {maximumFractionDigits:2})} (${profitPct}%)</div>
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
        });

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
            cartItems.push({ sku: matched.sku, name: matched.name, qty, unitPrice: matched.price, costPrice: matched.costPrice || 0 });
        } else {
            cartItems.push({ sku: null, name: inputVal, qty, unitPrice: null, costPrice: 0 });
        }

        document.getElementById('builderItemName').value = '';
        document.getElementById('builderQty').value = '1';
        const dd = document.getElementById('builderDropdown');
        if (dd) dd.style.display = 'none';
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

        let approxTotal = 0, approxCostTotal = 0;
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
        window.open(`https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`, '_blank');
    }

    function addNewOrderItem() {
        const inputVal = document.getElementById('newOrderBuilderItemName').value.trim();
        const qty = parseInt(document.getElementById('newOrderBuilderQty').value) || 1;
        if (!inputVal) return;

        const matched = findBestProductMatch(inputVal);
        if (matched) {
            newOrderCartItems.push({ sku: matched.sku, name: matched.name, qty, unitPrice: matched.price, costPrice: matched.costPrice || 0 });
        } else {
            newOrderCartItems.push({ sku: null, name: inputVal, qty, unitPrice: null, costPrice: 0 });
        }

        document.getElementById('newOrderBuilderItemName').value = '';
        document.getElementById('newOrderBuilderQty').value = '1';
        const dd = document.getElementById('newOrderDropdown');
        if (dd) dd.style.display = 'none';
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

        if (!name) { alert('Please enter the Shopkeeper Name.'); document.getElementById('newCustName').focus(); return; }
        if (!mobile) { alert('Please enter the Mobile Number.'); document.getElementById('newCustMobile').focus(); return; }
        if (!newOrderCartItems.length) { alert('Please add at least one item to the cart.'); return; }

        const message = buildWhatsAppOrderMessage('✨ *NEW CUSTOMER ORDER - GO-KIRANA*', name, mobile, newOrderCartItems);
        window.open(`https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`, '_blank');
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
        const sorted = sortOrdersDesc(orders);
        stream.innerHTML = withMonthDividers(sorted, o => {
            const orderId = o['Id'] || o['Order ID'] || '';
            return `
            <div class="order-card">
                <div class="order-card-header">
                    <div>
                        <div class="order-id">${orderId}</div>
                        <div class="order-date">👤 <strong>${o['CustomerName']||'Customer'}</strong> • 📅 ${normalizeSheetDate(o['Order Date'])}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:800; font-size:1.05rem;">₹${parseFloat(String(o['Bill Amout']||o['Bill Amount']||0).replace(/[^0-9.-]+/g,"")).toLocaleString('en-IN', {maximumFractionDigits:2})}</div>
                        <span class="profit-badge profit-pos">Profit: ₹${(parseFloat(o['Profit/Loss']) || 0).toLocaleString('en-IN', {maximumFractionDigits:2})}</span>
                    </div>
                </div>
                <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); text-align:right;">
                    <button class="btn-analytics" onclick="viewOrderBill('${orderId}')">🧾 View Bill</button>
                </div>
            </div>
            `;
        });
    }

    // --- CUSTOMER BILL / RECEIPT -------------------------------------------
    // Opens a standalone, print-ready bill in a new tab (same Blob-URL
    // pattern as orders.js's draft report) — this doubles as "view" (it's a
    // full clean page) and "download PDF" (the tab has its own print
    // button; picking "Save as PDF" as the destination is the export).
    // No GST/tax fields anywhere — the business isn't GST-registered.

    // Google Sheets stores Order Date as a real Date cell at local (IST)
    // midnight. Apps Script serializes that to JSON as a UTC ISO timestamp
    // (Date.toJSON()), and since IST is UTC+5:30, that shifts the calendar
    // date back by one day — "2026-07-31" becomes "2026-07-30T18:30:00.000Z".
    // Shifting by the IST offset before reading off the date recovers the
    // date the order was actually placed on.
    function normalizeSheetDate(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        if (!s.includes('T')) return s.substring(0, 10); // already a plain "YYYY-MM-DD" string
        const d = new Date(s);
        if (isNaN(d)) return s.substring(0, 10);
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        return new Date(d.getTime() + IST_OFFSET_MS).toISOString().substring(0, 10);
    }

    // Newest first; same-day orders tie-broken by Order ID (higher sequence
    // = placed later that day) so the order is stable and predictable.
    function sortOrdersDesc(orders) {
        return orders.slice().sort((a, b) => {
            const da = normalizeSheetDate(a['Order Date']);
            const db = normalizeSheetDate(b['Order Date']);
            if (da !== db) return db.localeCompare(da);
            const ida = String(a['Id'] || a['Order ID'] || '');
            const idb = String(b['Id'] || b['Order ID'] || '');
            return idb.localeCompare(ida);
        });
    }

    function monthLabel(dateStr) {
        if (!dateStr) return 'Unknown Date';
        const [y, m] = dateStr.split('-');
        return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }

    // Renders a list of order cards (already-built HTML strings, one per
    // order) with a month-divider inserted wherever the calendar month
    // changes. Orders must already be sorted (sortOrdersDesc) — this only
    // groups, it doesn't sort.
    function withMonthDividers(orders, cardHtmlFn) {
        let lastMonth = null;
        const parts = [];
        orders.forEach(o => {
            const dateStr = normalizeSheetDate(o['Order Date']);
            const month = dateStr ? dateStr.substring(0, 7) : '';
            if (month !== lastMonth) {
                parts.push(`<div class="month-divider">${monthLabel(dateStr)}</div>`);
                lastMonth = month;
            }
            parts.push(cardHtmlFn(o));
        });
        return parts.join('');
    }

    function billOrderById(orderId) {
        return rawOrders.find(o => String(o['Id'] || o['Order ID'] || '').trim() === orderId);
    }

    function billItemsForOrder(orderId) {
        return rawOrderItems.filter(i => String(i['Order ID'] || i['Id'] || '').trim() === orderId);
    }

    function billCustomerContact(order) {
        const custId = String(order['CustomerId'] || '').trim();
        const cust = rawCustomers.find(c => String(c['Id'] || c['ID'] || '').trim() === custId);
        if (!cust) return '';
        const mobile = cust['Mobile Number'] || '';
        return mobile ? `+${cust['Country Code'] || '91'} ${mobile}` : '';
    }

    function buildBillSection(order, items) {
        const orderId = order['Id'] || order['Order ID'] || '';
        const custName = order['CustomerName'] || 'Customer';
        const custContact = billCustomerContact(order);
        const dateStr = normalizeSheetDate(order['Order Date']);

        const deliveryCharge = parseFloat(String(order['Delivery Cost'] ?? order['Delivery Charge'] ?? 0).replace(/[^0-9.-]+/g, '')) || 0;

        let itemsSubtotal = 0;
        const rows = items.map((it, idx) => {
            const sku = (it['SKU'] || '').trim();
            const prod = productMapBySKU[sku];
            const name = prod ? prod.name : (sku || 'Item');
            const qty = parseInt(it['Quantity']) || 0;
            const unitPrice = parseFloat(String(it['Unit Price'] || 0).replace(/[^0-9.-]+/g, '')) || 0;
            const lineTotal = parseFloat(String(it['Calculated Total'] || (qty * unitPrice)).replace(/[^0-9.-]+/g, '')) || (qty * unitPrice);
            itemsSubtotal += lineTotal;

            return `
            <tr>
                <td>${idx + 1}</td>
                <td>${name}</td>
                <td style="text-align:center;">${qty}</td>
                <td style="text-align:right;">₹${unitPrice.toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                <td style="text-align:right;">₹${lineTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
            </tr>`;
        }).join('');

        const sheetBillAmount = parseFloat(String(order['Bill Amout'] || order['Bill Amount'] || 0).replace(/[^0-9.-]+/g, ''));
        const grandTotal = sheetBillAmount || (itemsSubtotal + deliveryCharge);

        const deliveryRow = deliveryCharge > 0
            ? `<div class="totals-row"><span>Delivery</span><span>₹${deliveryCharge.toLocaleString('en-IN', {maximumFractionDigits:2})}</span></div>`
            : `<div class="totals-row"><span>Delivery</span><span><span class="strike">₹50</span> <span class="free-tag">FREE</span></span></div>`;

        return `
        <div class="bill-page">
            <div class="bill-card">
                <div class="bill-header">
                    <div class="brand-block">
                        <img class="brand-logo" src="${location.origin}/app/assets/icons/icon-512.png" alt="Go-Kirana">
                        <div>
                            <div class="brand-name">Kirana</div>
                            <div class="brand-tagline">Munafa Aapka, Mehnat Hamari</div>
                        </div>
                    </div>
                    <div class="bill-meta">
                        <div class="bill-meta-label">Bill</div>
                        <div class="bill-no">${orderId}</div>
                        <div class="bill-date">${dateStr}</div>
                    </div>
                </div>

                <div class="bill-parties">
                    <div>
                        <div class="party-label">Billed To</div>
                        <div class="party-name">${custName}</div>
                        ${custContact ? `<div class="party-detail">📱 ${custContact}</div>` : ''}
                    </div>
                    <div class="party-right">
                        <div class="party-label">From</div>
                        <div class="party-name">Go-Kirana Distribution</div>
                        <div class="party-detail">📞 +91 7678153075</div>
                        <div class="party-detail">✉️ gokirana.wholesale@gmail.com</div>
                    </div>
                </div>

                <table class="bill-items">
                    <thead><tr><th>#</th><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Amount</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center; color:#94a3b8;">No items on this order.</td></tr>'}</tbody>
                </table>

                <div class="bill-totals">
                    <div class="totals-row"><span>Subtotal</span><span>₹${itemsSubtotal.toLocaleString('en-IN', {maximumFractionDigits:2})}</span></div>
                    ${deliveryRow}
                    <div class="totals-row grand"><span>Grand Total</span><span>₹${grandTotal.toLocaleString('en-IN', {maximumFractionDigits:2})}</span></div>
                </div>

                <div class="bill-footer">
                    <div class="thank-you">🙏 Thank you for shopping with Go-Kirana!</div>
                    <div class="footer-contact">📞 +91 7678153075 &nbsp;•&nbsp; ✉️ gokirana.wholesale@gmail.com</div>
                </div>
            </div>
        </div>`;
    }

    function wrapBillDocument(title, sectionsHtml, summaryHtml) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
    :root {
        --navy: #2C3E50;
        --red: #E53935;
        --gold: #C9971C;
        --muted: #64748b;
        --border: #e2e8f0;
        --bg: #F4F7F6;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: var(--navy); background: var(--bg); margin: 0; padding: 24px; }
    .toolbar { max-width: 760px; margin: 0 auto 20px auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
    .toolbar h1 { font-size: 1.1rem; margin: 0; }
    .toolbar .sub { color: var(--muted); font-size: 0.8rem; }
    .print-btn { background: var(--red); color: white; border: none; padding: 10px 20px; border-radius: 24px; font-weight: 700; cursor: pointer; font-size: 0.9rem; }

    .bill-page { max-width: 760px; margin: 0 auto 24px auto; page-break-after: always; }
    .bill-page:last-child { page-break-after: auto; }

    .bill-card { background: white; border-radius: 16px; box-shadow: 0 4px 16px rgba(44,62,80,0.08); padding: 32px; }
    .bill-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid var(--navy); padding-bottom: 18px; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
    .brand-block { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 48px; height: 48px; object-fit: contain; border-radius: 8px; }
    .brand-name { font-size: 1.4rem; font-weight: 800; }
    .brand-name::before { content: 'Go-'; color: var(--red); }
    .brand-tagline { font-size: 0.7rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
    .bill-meta { text-align: right; }
    .bill-meta-label { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gold); }
    .bill-no { font-family: monospace; font-weight: 800; font-size: 1rem; }
    .bill-date { font-size: 0.8rem; color: var(--muted); }

    .bill-parties { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 22px; flex-wrap: wrap; }
    .party-right { text-align: right; }
    .party-label { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; margin-bottom: 4px; }
    .party-name { font-weight: 800; font-size: 0.95rem; }
    .party-detail { font-size: 0.82rem; color: var(--muted); margin-top: 2px; }

    table.bill-items { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 0.85rem; }
    table.bill-items th { text-align: left; background: var(--bg); padding: 8px 10px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border-bottom: 2px solid var(--border); }
    table.bill-items td { padding: 9px 10px; border-bottom: 1px solid var(--border); }

    .bill-totals { max-width: 280px; margin-left: auto; margin-bottom: 24px; }
    .totals-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 0.88rem; }
    .totals-row .strike { text-decoration: line-through; color: var(--muted); margin-right: 6px; }
    .totals-row .free-tag { color: #15803d; font-weight: 800; }
    .totals-row.grand { border-top: 2px solid var(--navy); margin-top: 6px; padding-top: 10px; font-size: 1.1rem; font-weight: 800; color: var(--red); }

    .bill-footer { text-align: center; border-top: 1px dashed var(--border); padding-top: 16px; }
    .thank-you { font-weight: 700; margin-bottom: 4px; }
    .footer-contact { font-size: 0.78rem; color: var(--muted); }

    .summary-banner { max-width: 760px; margin: 0 auto 20px auto; background: white; border-radius: 12px; padding: 16px 20px; box-shadow: 0 2px 8px rgba(44,62,80,0.06); font-size: 0.9rem; }

    @media print {
        body { background: white; padding: 0; }
        .toolbar { display: none; }
        .bill-card { box-shadow: none; border: 1px solid var(--border); }
        .summary-banner { box-shadow: none; border: 1px solid var(--border); }
    }
</style>
</head>
<body>
    <div class="toolbar">
        <div>
            <h1>${title}</h1>
            <div class="sub">Generated ${new Date().toLocaleString('en-IN')}</div>
        </div>
        <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
    </div>
    ${summaryHtml || ''}
    ${sectionsHtml}
</body>
</html>`;
    }

    function openBillDocument(title, sectionsHtml, summaryHtml) {
        const html = wrapBillDocument(title, sectionsHtml, summaryHtml);
        const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const win = window.open(blobUrl, '_blank');
        if (!win) {
            alert('⚠️ Please allow popups to view the bill.');
            return;
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    function viewOrderBill(orderId) {
        const order = billOrderById(orderId);
        if (!order) { alert('Order not found.'); return; }
        const items = billItemsForOrder(orderId);
        openBillDocument(`Go-Kirana — Bill ${orderId}`, buildBillSection(order, items));
    }

    // --- DAY-WISE BILLS (admin only) ---------------------------------------
    // Generates every bill for a chosen date in one print-ready document
    // (each bill on its own page) so the admin can print/share a full day's
    // paperwork in one go.

    function ordersForDate(dateStr) {
        return rawOrders.filter(o => normalizeSheetDate(o['Order Date']) === dateStr);
    }

    function updateDayWiseBillsSummary() {
        const dateInput = document.getElementById('dayWiseBillsDate');
        const summaryEl = document.getElementById('dayWiseBillsSummary');
        if (!dateInput || !summaryEl) return;

        const orders = ordersForDate(dateInput.value);
        if (!orders.length) {
            summaryEl.innerHTML = `<span style="color:var(--text-muted);">No orders recorded for this date yet.</span>`;
            return;
        }

        const total = orders.reduce((sum, o) => sum + (parseFloat(String(o['Bill Amout']||o['Bill Amount']||0).replace(/[^0-9.-]+/g,'')) || 0), 0);
        summaryEl.innerHTML = `<strong>${orders.length}</strong> order(s) &nbsp;•&nbsp; Combined billed amount: <strong>₹${total.toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>`;
    }

    function generateDayWiseBills() {
        const dateInput = document.getElementById('dayWiseBillsDate');
        const dateStr = dateInput ? dateInput.value : '';
        if (!dateStr) { alert('Please choose a date.'); return; }

        const orders = ordersForDate(dateStr);
        if (!orders.length) {
            alert('No orders recorded for this date.');
            return;
        }

        const total = orders.reduce((sum, o) => sum + (parseFloat(String(o['Bill Amout']||o['Bill Amount']||0).replace(/[^0-9.-]+/g,'')) || 0), 0);
        const summaryHtml = `
        <div class="summary-banner">
            <strong>${orders.length}</strong> bill(s) for <strong>${dateStr}</strong> &nbsp;•&nbsp; Combined billed amount: <strong>₹${total.toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>
        </div>`;

        const sectionsHtml = orders.map(o => {
            const orderId = o['Id'] || o['Order ID'] || '';
            return buildBillSection(o, billItemsForOrder(orderId));
        }).join('');

        openBillDocument(`Go-Kirana — Bills for ${dateStr}`, sectionsHtml, summaryHtml);
    }

    function initDayWiseBillsTab() {
        const dateInput = document.getElementById('dayWiseBillsDate');
        if (dateInput && !dateInput.value) {
            dateInput.value = new Date().toISOString().substring(0, 10);
        }
        updateDayWiseBillsSummary();
    }

    // ===== SHOP INSIGHTS: Reorder (Table 1) + Upsell engines (Table 2) =====
    let II = { lines:[], baskets:{}, itemShops:{}, totalShops:0, totalOrders:0 };
    let skuToStd = {}, margByStd = {}, custIdToName = {};
    const EXCL_CATS = ['Tobacco','Sugar/Salt'];

    function toNum(x){ return parseFloat(String(x==null?0:x).replace(/[^0-9.-]+/g,'')) || 0; }

    function catOf(name){
        const s = String(name).toLowerCase();
        if (/cigar|cigerette|marlboro|commander|bidi|supari|gutka|pasand|gagan|kuber|dilbag|sada gold|do bhai|safal|tansen|sai bukka|zaffran/.test(s)) return 'Tobacco';
        if (s==='sugar' || s==='salt') return 'Sugar/Salt';
        if (/shampoo|clinic plus|sunsilk|\bdove\b|vatika|patanjali/.test(s)) return 'Shampoo';
        if (/soap/.test(s)) return 'Soap';
        if (/surf|wheel/.test(s)) return 'Detergent';
        if (/oil|refind/.test(s)) return 'Oil';
        if (/(dal|daal|chhole|chana|besan|moong|urad|arhar|masoor|malka)/.test(s) && !/namkeen|pari soya/.test(s)) return 'Pulses';
        if (/rice/.test(s)) return 'Rice';
        if (/tea/.test(s)) return 'Tea';
        if (/biscuit|parle-g|good day|rusk/.test(s)) return 'Biscuits';
        if (/bhujia|ghatia|peanut|boondi|kurkura|namkeen|lays|fan|finger|chips/.test(s)) return 'Namkeen';
        if (/toffee|chocolate|center fruit|pulse|snicker|melodi/.test(s)) return 'Candy';
        return 'Other';
    }

    function buildInsightIndex(){
        skuToStd = {}; margByStd = {};
        rawProducts.forEach(p=>{
            const sku=(p['SKU']||'').trim();
            const std=p['Standard Name']||p['Item Name']||sku;
            const pu=toNum(p['Price per Unit']), ap=toNum(p['Actual Price']);
            const mp = pu>0 ? ((pu-ap)/pu*100) : 0;
            if(sku) skuToStd[sku]=std;
            if(!(std in margByStd) || mp>margByStd[std]) margByStd[std]=mp;
        });
        const oidCust={};
        rawOrders.forEach(o=>{
            const id=String(o['Id']||o['Order ID']||'').trim();
            oidCust[id]={ cust:o['CustomerName']||'', cid:(o['CustomerId']||'').trim() };
        });
        const lines=[], baskets={}, itemShops={}, shopSet=new Set();
        rawOrderItems.forEach(i=>{
            const oid=String(i['Order ID']||i['Id']||'').trim();
            const oc=oidCust[oid]; if(!oc) return;
            const sku=(i['SKU']||'').trim();
            const std = skuToStd[sku] || (productMapBySKU[sku]?productMapBySKU[sku].name:sku);
            const qty = parseInt(i['Quantity'])||0;
            const up = toNum(i['Unit Price']), ap = toNum(i['Actual Price']);
            const rev = toNum(i['Calculated Total']);
            const mp = up>0 ? ((up-ap)/up*100) : 0;
            lines.push({oid, std, cust:oc.cust, cid:oc.cid, qty, rev, mp});
            (baskets[oid]=baskets[oid]||new Set()).add(std);
            (itemShops[std]=itemShops[std]||new Set()).add(oc.cust);
            if(oc.cust) shopSet.add(oc.cust);
        });
        II={ lines, baskets, itemShops, totalShops:shopSet.size, totalOrders:Object.keys(baskets).length };
    }

    function renderShopInsightSelect(){
        const sel=document.getElementById('shopInsightSelect');
        if(!sel) return;
        custIdToName={};
        const opts = processedCustomers.map(c=>{
            const id=String(c['Id']||c['ID']||'').trim();
            custIdToName[id]=c['Owner Name']||'';
            return `<option value="${id}">${c['Owner Name']} (${c.totalOrds} orders)</option>`;
        }).join('');
        sel.innerHTML = '<option value="">— Choose a shop —</option>'+opts;
    }

    function siBadge(txt, color){
        const map={green:'#dcfce7|#15803d', amber:'#ffedd5|#c2410c', red:'#fee2e2|#b91c1c', gray:'#f1f5f9|#64748b'};
        const parts=(map[color]||map.gray).split('|');
        return `<span style="background:${parts[0]}; color:${parts[1]}; font-size:0.7rem; font-weight:800; padding:3px 9px; border-radius:12px; white-space:nowrap;">${txt}</span>`;
    }

    function siPct(v){
        const cls = v>0?'profit-pos':(v<0?'profit-neg':'');
        return `<span class="profit-badge ${cls}">${v.toFixed(2)}%</span>`;
    }

    function renderShopInsights(){
        const sel=document.getElementById('shopInsightSelect');
        const custId=sel.value;
        const t1=document.getElementById('si-table1');
        const t2=document.getElementById('si-table2');
        const meta=document.getElementById('si-meta');
        if(!custId){ t1.innerHTML=''; t2.innerHTML='<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">Select a shop to see its reorder list and upsell recommendations.</p>'; meta.innerText=''; return; }
        const custName = custIdToName[custId] || '';
        const nameLC = custName.toLowerCase();
        const mine = II.lines.filter(l => (l.cid && l.cid===custId) || (l.cust||'').toLowerCase()===nameLC);

        const g={};
        mine.forEach(l=>{ const s=g[l.std]=g[l.std]||{orders:new Set(), qty:0, rev:0, mps:[]}; s.orders.add(l.oid); s.qty+=l.qty; s.rev+=l.rev; s.mps.push(l.mp); });
        const totRev = Object.values(g).reduce((a,s)=>a+s.rev,0)||1;
        const rows1 = Object.keys(g).map(std=>{ const s=g[std]; const oc=s.orders.size; const avgmp=s.mps.reduce((a,b)=>a+b,0)/s.mps.length; return {std, orders:oc, avgvol:s.qty/oc, rev:s.rev, revpct:100*s.rev/totRev, profit:avgmp}; }).sort((a,b)=>b.rev-a.rev);
        const shopOrders = new Set(mine.map(l=>l.oid)).size;
        meta.innerText = `${custName} • ${shopOrders} orders • ${rows1.length} distinct items`;

        if(!rows1.length){ t1.innerHTML='<p style="color:var(--text-muted); font-size:0.85rem; padding:12px;">No order history for this shop.</p>'; t2.innerHTML=''; return; }

        const t1cols = `<thead><tr style="text-align:left; color:var(--text-muted); border-bottom:2px solid var(--border);">
        <th style="padding:8px;">Item</th><th style="padding:8px; text-align:center;">Orders</th><th style="padding:8px; text-align:center;">Avg vol</th><th style="padding:8px; text-align:right;">Revenue</th><th style="padding:8px; text-align:right;">Rev %</th><th style="padding:8px; text-align:right;">Profit %</th></tr></thead>`;
        const t1body = arr => arr.map(r=>`<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px; font-weight:700;">${r.std}</td>
        <td style="padding:8px; text-align:center;">${r.orders}</td>
        <td style="padding:8px; text-align:center;">${r.avgvol.toFixed(1)}</td>
        <td style="padding:8px; text-align:right;">₹${Math.round(r.rev).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
        <td style="padding:8px; text-align:right;">${r.revpct.toFixed(1)}%</td>
        <td style="padding:8px; text-align:right;">${siPct(r.profit)}</td></tr>`).join('');
        const mostOrdered = [...rows1].sort((a,b)=> (b.orders-a.orders) || (b.rev-a.rev)).slice(0,5);
        const mostMargin = [...rows1].filter(r=>r.profit>0).sort((a,b)=> (b.profit-a.profit) || (b.rev-a.rev)).slice(0,5);
        const sumPct = arr => arr.reduce((a,r)=>a+r.revpct,0);
        const revNote = arr => arr.length ? `<div style="font-size:0.78rem; color:var(--text-secondary); font-weight:700; margin-top:8px;">These ${arr.length} items = ${sumPct(arr).toFixed(1)}% of his total revenue</div>` : '';
        const emptyT1 = `<tr><td colspan="6" style="padding:10px; color:var(--text-muted); font-size:0.8rem;">No positive-margin items yet.</td></tr>`;
        t1.innerHTML = `<div class="section-title" style="font-size:1rem;">📦 Table 1A — Most ordered <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">top 5 by no. of orders</span></div>
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.82rem;">${t1cols}<tbody>${t1body(mostOrdered)}</tbody></table></div>
        ${revNote(mostOrdered)}
        <div class="section-title" style="font-size:1rem; margin-top:22px;">💰 Table 1B — Highest margin <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">top 5 by profit %, non-zero only</span></div>
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.82rem;">${t1cols}<tbody>${mostMargin.length ? t1body(mostMargin) : emptyT1}</tbody></table></div>
        ${revNote(mostMargin)}`;

        const mineSet = new Set(Object.keys(g));
        const myCats = new Set([...mineSet].map(catOf).filter(c=>EXCL_CATS.indexOf(c)<0 && c!=='Other'));
        const allItems = Object.keys(II.itemShops);
        const eng={};
        const addEng=(std,e)=>{ (eng[std]=eng[std]||new Set()).add(e); };
        const star=std=> (eng[std]&&eng[std].size>=2)?' ⭐':'';

        const cand1 = allItems.filter(std=>!mineSet.has(std) && EXCL_CATS.indexOf(catOf(std))<0).map(std=>{
            const peers=[...II.itemShops[std]].filter(c=>(c||'').toLowerCase()!==nameLC).length;
            return {std, peers, margin:Math.max(margByStd[std]||0,0)};
        }).filter(x=>x.peers>=2);
        const a1=[...cand1].sort((x,y)=>y.peers-x.peers).slice(0,5);
        const b1=cand1.filter(x=>x.margin>0).sort((x,y)=>(y.peers*y.margin)-(x.peers*x.margin)).slice(0,5);
        a1.concat(b1).forEach(x=>addEng(x.std,'P'));

        const catAnchors = {};
        mineSet.forEach(std=>{ const c=catOf(std); if(EXCL_CATS.indexOf(c)>=0) return; (catAnchors[c]=catAnchors[c]||[]).push(std); });
        const cand2 = allItems.filter(std=>!mineSet.has(std) && myCats.has(catOf(std))).map(std=>({std,cat:catOf(std),margin:Math.max(margByStd[std]||0,0),anchors:(catAnchors[catOf(std)]||[]).slice(0,2)})).sort((a,b)=>b.margin-a.margin).slice(0,5);
        cand2.forEach(x=>addEng(x.std,'C'));

        const bases3 = mostOrdered.map(r=>r.std);
        const basketArr = Object.values(II.baskets);
        const picked3 = new Set();
        const cand3 = [];
        bases3.forEach(base=>{
            let nb=0; const cc={};
            basketArr.forEach(set=>{
                if(!set.has(base)) return;
                nb++;
                set.forEach(s=>{ if(mineSet.has(s)||EXCL_CATS.indexOf(catOf(s))>=0||(margByStd[s]||0)<=0) return; cc[s]=(cc[s]||0)+1; });
            });
            if(!nb) return;
            const rankedC = Object.keys(cc).filter(c=>cc[c]>=2).sort((a,b)=>cc[b]-cc[a]);
            for(const c of rankedC){
                if(picked3.has(c)) continue;
                picked3.add(c);
                cand3.push({std:c, base, conf:Math.round(100*cc[c]/nb), margin:margByStd[c]||0});
                break;
            }
        });
        cand3.forEach(x=>addEng(x.std,'O'));

        const e1status = II.totalShops>=12 ? siBadge('✅ Reliable','green') : (II.totalShops>=6 ? siBadge('🟡 Usable','amber') : siBadge('🔒 Locked','red'));
        const e2ok = shopOrders>=3 && myCats.size>=2;
        const e2status = e2ok ? siBadge('✅ Reliable','green') : siBadge('⚠️ Needs history','amber');
        const e3status = II.totalOrders>=250 ? siBadge('✅ Reliable','green') : (II.totalOrders>=100 ? siBadge('🟡 Usable','amber') : siBadge('⚠️ Maturing '+II.totalOrders+'/250','amber'));

        const listRows = (arr, cols) => arr.length ? arr.map(r=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:7px; font-weight:700;">${r.std}${star(r.std)}</td>${cols(r)}</tr>`).join('') : `<tr><td colspan="3" style="padding:10px; color:var(--text-muted); font-size:0.8rem;">None qualify yet.</td></tr>`;

        let html = `<div class="section-title" style="font-size:1rem;">🚀 Table 2 — Grow the basket</div>`;

        if (II.totalShops < 6){
            html += `<div style="background:#fef2f2; border:1px solid #fecaca; padding:14px; border-radius:12px; margin-bottom:16px;"><strong style="color:#991b1b; font-size:0.9rem;">① Popular near you</strong> ${siBadge('🔒 Locked','red')}<p style="color:#7f1d1d; font-size:0.8rem; margin-top:6px;">Too few shops (only ${II.totalShops}) to spot demand patterns yet — this sharpens as you add shops.</p></div>`;
        } else {
            const anyZero = a1.some(x=>x.margin<=0);
            html += `<div style="background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;"><strong style="font-size:0.9rem;">① Popular near you</strong> ${e1status}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); font-weight:700; margin:8px 0 4px;">1A · Pure demand (margin ignored)</div>
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;"><tbody>${listRows(a1, r=>`<td style="padding:7px; text-align:center;">${r.peers} shops</td><td style="padding:7px; text-align:right;">${siPct(r.margin)}</td>`)}</tbody></table>
            ${anyZero ? `<p style="background:#fffbeb; border:1px solid #fde68a; color:#92400e; font-size:0.75rem; padding:8px 10px; border-radius:8px; margin-top:8px;">⚠️ Some earn 0% — negotiate a better buy price or add a delivery charge before pushing.</p>` : ``}
            <div style="font-size:0.78rem; color:var(--text-muted); font-weight:700; margin:14px 0 4px;">1B · Popular + margin (push today)</div>
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem;"><tbody>${listRows(b1, r=>`<td style="padding:7px; text-align:center;">${r.peers} shops</td><td style="padding:7px; text-align:right;">${siPct(r.margin)}</td>`)}</tbody></table></div>`;
        }

        html += `<div style="background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;"><strong style="font-size:0.9rem;">② Fits what he sells</strong> ${e2status}</div>
        <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:8px;">Higher-margin items in categories he already trusts you for.</p>
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;"><tbody>${cand2.length ? cand2.map(r=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:7px; font-weight:700;">${r.std}${star(r.std)}<div style="font-size:0.7rem; color:var(--text-muted); font-weight:600;">Because he buys ${r.cat}${r.anchors.length?': '+r.anchors.join(', '):''}</div></td><td style="padding:7px; text-align:right; vertical-align:top;">${siPct(r.margin)}</td></tr>`).join('') : `<tr><td style="padding:10px; color:var(--text-muted); font-size:0.8rem;">None qualify yet.</td></tr>`}</tbody></table></div>`;

        html += `<div style="background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;"><strong style="font-size:0.9rem;">③ Bought together</strong> ${e3status}</div>
        <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:8px;">Pairs with his current orders.${II.totalOrders<250?' Treat as a hint — gets sharper as you grow.':''}</p>
        <table style="width:100%; border-collapse:collapse; font-size:0.8rem;"><tbody>${cand3.length ? cand3.map(r=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:7px; font-weight:700;">${r.std}${star(r.std)}<div style="font-size:0.7rem; color:var(--text-muted); font-weight:600;">Because he buys ${r.base} · ${r.conf}% co-buy this</div></td><td style="padding:7px; text-align:right; vertical-align:top;">${siPct(r.margin)}</td></tr>`).join('') : `<tr><td style="padding:10px; color:var(--text-muted); font-size:0.8rem;">None qualify yet.</td></tr>`}</tbody></table></div>`;

        t2.innerHTML = html;
    }

    function renderInventoryGuide(){
        const container=document.getElementById('invGuideBody');
        const rangeLbl=document.getElementById('invGuideRange');
        if(!container) return;
        const TARGET=4.0;
        const oidDate={}, oidDateStr={};
        rawOrders.forEach(o=>{ const id=String(o['Id']||o['Order ID']||'').trim(); const ds=String(o['Order Date']||'').trim(); oidDate[id]= ds ? new Date(ds) : null; oidDateStr[id]=ds; });
        const today=new Date();
        const cutoff=new Date(today.getTime()-30*24*3600*1000);
        const fmt=d=>d.toISOString().slice(0,10);
        if(rangeLbl) rangeLbl.innerText=`Last 30 days · ${fmt(cutoff)} → ${fmt(today)}`;
        const g={};
        II.lines.forEach(l=>{ const d=oidDate[l.oid]; if(!d || isNaN(d) || d<cutoff) return; const s=g[l.std]=g[l.std]||{orders:new Set(), rev:0, prof:0, wk:new Set()}; s.orders.add(l.oid); s.rev+=l.rev; s.prof+=l.rev*(l.mp/100); s.wk.add(Math.floor((today-d)/(7*86400000))); });
        const bySku={};
        rawProducts.forEach(p=>{ const sku=(p['SKU']||'').trim(); if(!sku) return; bySku[sku]={std:p['Standard Name']||p['Item Name']||sku, item:p['Item Name']||p['Standard Name']||sku, buy:toNum(p['Actual Price']), sell:toNum(p['Price per Unit'])}; });
        const skuBuys={};
        rawOrderItems.forEach(i=>{ const sku=(i['SKU']||'').trim(); if(!bySku[sku]) return; const b=toNum(i['Actual Price']); if(b>0){ (skuBuys[sku]=skuBuys[sku]||[]).push({d:oidDateStr[String(i['Order ID']||i['Id']||'').trim()]||'', b:b}); } });
        const variants={};
        Object.keys(bySku).forEach(sku=>{ const pr=bySku[sku]; const sb=(skuBuys[sku]||[]).slice().sort((a,b)=>a.d.localeCompare(b.d)); const curBuy=sb.length?sb[sb.length-1].b:pr.buy; const bestBuy=sb.length?Math.min.apply(null,sb.map(x=>x.b)):pr.buy; const firstBuy=sb.length?sb[0].b:pr.buy; const margin=pr.sell>0?100*(pr.sell-curBuy)/pr.sell:0; const trend=curBuy>firstBuy+0.01?'up':(curBuy<firstBuy-0.01?'down':'flat'); (variants[pr.std]=variants[pr.std]||[]).push({item:pr.item, curBuy, bestBuy, sell:pr.sell, margin, trend}); });
        const rows=Object.keys(g).map(std=>{ const s=g[std]; const oc=s.orders.size; const margin= s.rev ? 100*s.prof/s.rev : 0; const actual=s.prof; const potential=Math.max(margin,TARGET)/100*s.rev; const weekly=[0,1,2,3].every(w=>s.wk.has(w)); const green=(weekly || oc>=10) && s.rev>=1000; return {std, orders:oc, rev:s.rev, margin, actual, potential, gapProfit: potential-actual, green, vars: variants[std]||[]}; }).sort((a,b)=>b.rev-a.rev);
        if(!rows.length){ container.innerHTML='<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No orders in the last 30 days.</p>'; return; }
        const totRev=rows.reduce((a,r)=>a+r.rev,0);
        const totActual=rows.reduce((a,r)=>a+r.actual,0);
        const totPotential=rows.reduce((a,r)=>a+r.potential,0);
        const totGap=totPotential-totActual;
        const greenCount=rows.filter(r=>r.green).length;
        const hotBg='var(--primary-light)';
        container.innerHTML=`<div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:8px;"><span style="display:inline-block; width:11px; height:11px; background:${hotBg}; border:1px solid var(--primary); border-radius:3px; vertical-align:-1px; margin-right:5px;"></span>Light green = ${greenCount} core items (ordered every week, or 10+ orders this month, with ₹1,000+ revenue) · Actual = profit now · Potential = profit at ${TARGET}% · Gap = the difference · tap a row for variant detail</div>
        <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
        <thead><tr style="text-align:left; color:var(--text-muted); border-bottom:2px solid var(--border);">
        <th style="padding:9px;">#</th><th style="padding:9px;">Item</th><th style="padding:9px; text-align:center;">Orders</th><th style="padding:9px; text-align:right;">Revenue</th><th style="padding:9px; text-align:right;">Rev share</th><th style="padding:9px; text-align:right;">Margin %</th><th style="padding:9px; text-align:right;">Actual profit</th><th style="padding:9px; text-align:right;">Potential (${TARGET}%)</th><th style="padding:9px; text-align:right;">Profit gap</th><th style="padding:9px; text-align:center;">At best buy?</th><th style="padding:9px; text-align:center;">Bulk helps?</th></tr></thead><tbody>`
        + rows.map((r,i)=>{
          const hot = r.green;
          const bg = hot ? hotBg : 'transparent';
          let vh='';
          if(r.vars.length){
            vh+=`<tr style="font-size:0.68rem; color:var(--text-muted); background:var(--bg); text-transform:uppercase; letter-spacing:0.02em;"><td style="padding:5px 9px 5px 24px;">Pack</td><td style="padding:5px; text-align:right;">Cur. buy</td><td style="padding:5px; text-align:right;">Best buy</td><td style="padding:5px; text-align:right;">Sell</td><td style="padding:5px; text-align:right;">Margin</td><td style="padding:5px; text-align:right;">Buy → 4%</td><td style="padding:5px; text-align:center;">Trend</td></tr>`;
          }
          r.vars.forEach(v=>{
            const tr = v.trend==='down'?'<span style="color:#15803d;">↓ cheaper</span>':(v.trend==='up'?'<span style="color:#b91c1c;">↑ dearer</span>':'<span style="color:var(--text-muted);">→ flat</span>');
            const needBuy = v.sell>0 ? Math.round(v.sell*(1-4/100)) : 0;
            const proven = v.bestBuy>0 && v.bestBuy<=needBuy;
            const bestCell = proven ? '<span style="color:#15803d; font-weight:700;">₹'+Math.round(v.bestBuy)+' ✓</span>' : '₹'+Math.round(v.bestBuy);
            vh+=`<tr style="font-size:0.76rem; background:var(--bg); border-bottom:1px solid var(--border);"><td style="padding:6px 9px 6px 24px;">${v.item}</td><td style="padding:6px; text-align:right;">₹${Math.round(v.curBuy)}</td><td style="padding:6px; text-align:right;">${bestCell}</td><td style="padding:6px; text-align:right;">₹${Math.round(v.sell)}</td><td style="padding:6px; text-align:right;">${v.margin.toFixed(1)}%</td><td style="padding:6px; text-align:right; color:var(--primary-dark); font-weight:700;">₹${needBuy}</td><td style="padding:6px; text-align:center;">${tr}</td></tr>`;
          });
          const caret = r.vars.length ? ' <span style="color:var(--text-muted); font-weight:400;">▾</span>' : '';
          const allBest = r.vars.length ? r.vars.every(v=>v.curBuy<=v.bestBuy+0.01) : null;
          const bestFlag = allBest===null ? '<span style="color:var(--text-muted);">—</span>' : (allBest ? siBadge('Yes','green') : siBadge('No','red'));
          let bulkFlag='<span style="color:var(--text-muted);">—</span>';
          if(r.vars.length>=2){ const sv=r.vars.slice().sort((a,b)=>a.sell-b.sell); const diff=sv[sv.length-1].margin - sv[0].margin; if(diff>0.3) bulkFlag=siBadge('Bulk +'+diff.toFixed(1)+'%','green'); }
          return `<tr ${r.vars.length?`onclick="toggleCockpit(${i})" style="cursor:pointer; `:'style="'}border-bottom:1px solid var(--border); background:${bg};">
        <td style="padding:9px; color:var(--text-muted);">${i+1}</td>
        <td style="padding:9px; font-weight:700;">${r.std}${caret}</td>
        <td style="padding:9px; text-align:center;">${r.orders}</td>
        <td style="padding:9px; text-align:right;">₹${Math.round(r.rev).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
        <td style="padding:9px; text-align:right;">${(100*r.rev/totRev).toFixed(1)}%</td>
        <td style="padding:9px; text-align:right;">${siPct(r.margin)}</td>
        <td style="padding:9px; text-align:right;">₹${Math.round(r.actual).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
        <td style="padding:9px; text-align:right; color:var(--text-muted);">₹${Math.round(r.potential).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
        <td style="padding:9px; text-align:right; font-weight:700;">₹${Math.round(r.gapProfit).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
        <td style="padding:9px; text-align:center;">${bestFlag}</td>
        <td style="padding:9px; text-align:center;">${bulkFlag}</td></tr>`
        + (r.vars.length?`<tr id="ck-${i}" style="display:none;"><td colspan="11" style="padding:0;"><table style="width:100%; border-collapse:collapse;"><tbody>${vh}</tbody></table></td></tr>`:'');}).join('')
        + `</tbody></table></div>
        <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:700; margin-top:10px;">${rows.length} items · profit now ₹${Math.round(totActual).toLocaleString('en-IN', {maximumFractionDigits:2})} → ₹${Math.round(totPotential).toLocaleString('en-IN', {maximumFractionDigits:2})} at ${TARGET}% · gap ₹${Math.round(totGap).toLocaleString('en-IN', {maximumFractionDigits:2})}</div>`;
    }

    function toggleCockpit(i){ var el=document.getElementById('ck-'+i); if(el) el.style.display = (el.style.display==='none'||!el.style.display) ? 'table-row' : 'none'; }

    function switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.pill-btn').forEach(el => el.classList.remove('active'));

        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');

        document.querySelectorAll('.nav-pills .pill-btn').forEach(btn => {
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
        handlePriceCardTap,
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
        closeModal,
        renderShopInsights,
        toggleCockpit,
        viewOrderBill,
        updateDayWiseBillsSummary,
        generateDayWiseBills
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call fetchLiveData() here, or every navigation double-fetches.
    window.GK_viewInit = () => fetchLiveData(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
