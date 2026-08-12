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

    // Draft Orders (sheet-backed): admin sees/manages every agent's rows.
    // activeDraftOrderId mirrors Agent Hub's state-reset edge case — must be
    // reset to null whenever a *fresh* order is started (openOrderForm /
    // startFreshNewOrder), otherwise submitting a different/new order would
    // silently update the previously-edited draft instead of creating one.
    let draftOrders = [];
    let activeDraftOrderId = null;
    let assigningDraftOrderId = null;

    // Inventory management state
    let rawInventory = [];
    let invSelectedSku = null;
    let invSelectedName = null;
    let editingInventorySku = null;
    let bulkInventoryQueue = [];

    // Add Products state
    let productQueue = [];

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
            // Chart.js (a CDN fetch) has nothing to do with the sheet data
            // below — it used to be awaited first, which just delayed the
            // start of the (already slow) data fetch for no reason. Now it
            // loads in parallel with everything else.
            //
            // getDraftOrders() is NOT in this Promise.all — it's the one
            // request that's never cached client-side (see api.js: it's
            // frequently-mutated, multi-user data, so a stale cache would
            // actively mislead), which means it pays the full ~1.5-2s Apps
            // Script round-trip on *every single navigation*, even when
            // every sheet below is an instant local-cache hit. Since the
            // shell re-runs this whole view fresh on every tab switch
            // (see app/index.html's router), that made switching between
            // Admin/Agent Hub feel slow even right after the first load,
            // for no reason the rest of the view needed. It's now fetched
            // separately, below, without blocking anything else.
            const [, sheets] = await Promise.all([
                loadChartJs(),
                // One batched request for all sheet tabs instead of N
                // separate ones — each doPost independently reopens the
                // spreadsheet and Apps Script has real concurrency limits,
                // so firing many at once was the main source of
                // "connection error, works on retry".
                GK.api.getSheets(['Customers', 'Orders', 'Order Details', 'Products', 'Audit Log', 'Inventory'], { force })
            ]);

            rawCustomers = sheets['Customers'] || [];
            rawOrders = sheets['Orders'] || [];
            rawOrderItems = sheets['Order Details'] || [];
            rawProducts = sheets['Products'] || [];
            const auditLog = sheets['Audit Log'] || [];
            rawInventory = sheets['Inventory'] || [];

            productMapBySKU = {};
            productMapByNameAndPrice = {};

            rawProducts.forEach(p => {
                const sku = (p['SKU'] || '').trim();
                const name = p['Item Name'] || p['Standard Name'] || sku;
                const price = parseFloat(p['Price per Unit'] || 0);
                const costPrice = parseFloat(p['Cost Price'] || p['Actual Price'] || p['Cost'] || p['Purchase Price'] || 0);

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
            renderProductDatalists();
            filterStockTab();
            renderOrdersStream(rawOrders);
            buildInsightIndex();
            renderShopInsightSelect();
            renderInventoryGuide();
            initDayWiseBillsTab();
            renderDraftOrdersTab();
            renderAuditLogTab(auditLog);
            renderInventoryMgmtList(rawInventory);

            status.className = 'status-success';
            status.innerHTML = `✅ Store synced live at ${new Date().toLocaleTimeString()}`;

            // Draft Orders arrives after everything else, in the
            // background — see the comment above on why it's split out.
            // buildPendingNeededMap() (used by the Stock tab) also reads
            // draftOrders, so filterStockTab() gets one more pass once the
            // real data is in, in addition to renderDraftOrdersTab() itself.
            GK.api.getDraftOrders().then(drafts => {
                draftOrders = drafts;
                renderDraftOrdersTab();
                filterStockTab();
            }).catch(err => console.error('Failed to load Draft Orders:', err));
        } catch (err) {
            console.error(err);
            status.className = 'status-error';
            status.innerHTML = '⚠️ Connectivity issue fetching Google Sheet.';
        }
    }

    // Score used to be revenue(40) + frequency(30) + recency(30), no cap
    // beyond 100 — but revenue is scored relative to the current top
    // spender, so that customer ALWAYS gets full marks on that axis by
    // definition. Combined with frequency/recency both being easy to max
    // out (order >=2x/week, stay on schedule), the single biggest spender
    // could trivially land on a perfect 100 just by also being a regular,
    // on-time orderer — with zero regard for whether that revenue was
    // actually profitable. Adding profit margin as a 4th, genuinely
    // independent axis (high volume doesn't imply high margin — bulk
    // buyers often negotiate thinner ones) fixes that: hitting 100 now
    // requires excelling at all four, not just three correlated ones.
    function processCustomerScoresAndRanks() {
        let maxRevenue = 1;
        rawCustomers.forEach(c => {
            const amt = parseFloat(String(c['Total Amount']||0).replace(/[^0-9.-]+/g,"")) || 0;
            if (amt > maxRevenue) maxRevenue = amt;
        });

        // TARGET_MARGIN matches the 4% target used in Inventory Guide's
        // margin preview — the business's own bar for "a healthy sale",
        // reused here so a customer needs to be genuinely profitable (by
        // the same yardstick used elsewhere in the app), not just above 0%.
        const TARGET_MARGIN = 4.0;

        // Pre-aggregate every order's billed/profit total once (O(orders))
        // instead of re-scanning all of rawOrders for every customer
        // (O(customers × orders)) — matters once order history grows.
        // Each order is filed under BOTH its CustomerId and (lowercased)
        // CustomerName, mirroring the OR-match this app uses everywhere
        // else (openCustomerDetails etc.): a customer is credited with an
        // order if EITHER key matches.
        const custAgg = {};
        function addToCustAgg(key, billed, profit) {
            if (!key) return;
            if (!custAgg[key]) custAgg[key] = { billed: 0, profit: 0 };
            custAgg[key].billed += billed;
            custAgg[key].profit += profit;
        }
        rawOrders.forEach(o => {
            const billed = parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            const profit = parseFloat(String(o['Profit/Loss'] || 0).replace(/[^0-9.-]+/g,"")) || 0;
            addToCustAgg(String(o['CustomerId'] || '').trim(), billed, profit);
            addToCustAgg((o['CustomerName'] || '').trim().toLowerCase(), billed, profit);
        });

        processedCustomers = rawCustomers.map(c => {
            const totalAmt = parseFloat(String(c['Total Amount']||0).replace(/[^0-9.-]+/g,"")) || 0;
            const totalOrds = parseFloat(c['Total Orders']||0) || 0;
            const aov = parseFloat(String(c['AOV(Average Order Value)']||0).replace(/[^0-9.-]+/g,"")) || 0;
            const weeklyFreq = parseFloat(c['Order Frequency (Per Week)']||0) || 0;
            const daysSince = parseFloat(c['Days Since Last Order']||0) || 0;

            const custId = String(c['Id'] || c['ID'] || '').trim();
            const custNameKey = (c['Owner Name'] || '').trim().toLowerCase();
            const agg = (custId && custAgg[custId]) || custAgg[custNameKey] || { billed: 0, profit: 0 };
            const marginPct = agg.billed > 0 ? (agg.profit / agg.billed) * 100 : 0;

            const revenueScore = (totalAmt / maxRevenue) * 30;
            const freqScore = Math.min((weeklyFreq / 2.0) * 25, 25);
            const targetIntervalDays = weeklyFreq > 1.0 ? (7 / weeklyFreq) : 7;
            let recencyScore = 20 - Math.max(0, (daysSince - targetIntervalDays) * 2);
            recencyScore = Math.max(0, recencyScore);
            const marginScore = Math.max(0, Math.min(marginPct / TARGET_MARGIN, 1)) * 25;

            const finalScore = Math.round(revenueScore + freqScore + recencyScore + marginScore);
            const isFollowupDue = daysSince >= targetIntervalDays;

            return {
                ...c,
                score: finalScore,
                totalAmt,
                totalOrds,
                aov,
                weeklyFreq,
                daysSince,
                marginPct,
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

        // "Today"/"this month" must be read in IST, same as normalizeSheetDate
        // applies to every Order Date below — Date.now() in the browser is
        // UTC, and IST is 5.5 hours ahead, so a naive UTC "today" reads as
        // yesterday for the first ~5.5 hours of every IST day (and at month
        // boundaries, as the wrong month too).
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(Date.now() + IST_OFFSET_MS);
        const todayStr = nowIST.toISOString().substring(0, 10);
        const thisMonthStr = nowIST.toISOString().substring(0, 7);

        rawOrders.forEach(o => {
            const bill = parseFloat(String(o['Bill Amout'] || o['Bill Amount'] || '0').replace(/[^0-9.-]+/g,"")) || 0;
            const profit = parseFloat(String(o['Profit/Loss'] || '0').replace(/[^0-9.-]+/g,"")) || 0;

            totalRevenue += bill;
            totalProfit += profit;

            // normalizeSheetDate applies the same IST correction — the raw
            // Order Date cell serializes as a UTC ISO timestamp, which
            // shifts the calendar date back a day without it.
            const dateStr = normalizeSheetDate(o['Order Date']);
            if (dateStr.length >= 7) {
                const m = dateStr.substring(0, 7);
                monthlySales[m] = (monthlySales[m] || 0) + bill;

                if (m === thisMonthStr) {
                    monthOrders++;
                    monthSales += bill;
                    monthProfit += profit;
                }
            }
            if (dateStr === todayStr) {
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

    // --- STOCK TAB (quick item name + stock lookup, read-only) ---
    let stockShowLowOnly = false;

    // Combined quantity needed across all currently-visible draft orders
    // (every agent's, since admin sees them all), by SKU — an item can be
    // flagged before it hits zero if what's already been requested would
    // use up more than what's on hand.
    function buildPendingNeededMap() {
        const map = {};
        draftOrders.forEach(draft => {
            let items = [];
            try { items = JSON.parse(draft['ItemsJson'] || '[]'); } catch (e) { items = []; }
            items.forEach(item => {
                if (!item.sku) return;
                map[item.sku] = (map[item.sku] || 0) + (Number(item.qty) || 0);
            });
        });
        return map;
    }

    // 'out' (red): already at/below zero, or pending orders alone need more
    // than what's on hand. 'low' (amber): positive but at/under one case —
    // a natural "time to reorder" signal sized to how that item is actually
    // packed, falling back to a flat 5 units when case size isn't set.
    // 'good' (green): everything else.
    function computeStockLevel(row, pendingNeeded) {
        const sku = String(row['SKU'] || '').trim();
        const stock = toNum(row['Stock']);
        const unitsInCase = toNum(row['Units in case'] ?? row['Units In Case']);
        const needed = sku ? (pendingNeeded[sku] || 0) : 0;

        if (stock <= 0 || stock < needed) return 'out';
        if (unitsInCase > 0 ? stock <= unitsInCase : stock <= 5) return 'low';
        return 'good';
    }

    function renderStockTab(rows) {
        const container = document.getElementById('stockCardsContainer');
        if (!container) return;

        const pendingNeeded = buildPendingNeededMap();
        const withLevel = rows.map(r => ({ row: r, level: computeStockLevel(r, pendingNeeded) }));
        const visible = stockShowLowOnly ? withLevel.filter(x => x.level !== 'good') : withLevel;

        document.getElementById('stockItemCount').innerText = `${visible.length} Items`;

        if (!visible.length) {
            container.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">${stockShowLowOnly ? "Nothing low or out of stock right now. 🎉" : 'No inventory items found.'}</p>`;
            return;
        }

        const sorted = visible.slice().sort((a, b) => String(a.row['Item Name'] || '').localeCompare(String(b.row['Item Name'] || '')));
        const levelColors = {
            good: { border: '#10b981', bg: '#dcfce7', text: '#15803d' },
            low: { border: '#f59e0b', bg: '#fef3c7', text: '#92400e' },
            out: { border: '#ef4444', bg: '#fee2e2', text: '#b91c1c' }
        };

        container.innerHTML = sorted.map(({ row: r, level }) => {
            const stock = toNum(r['Stock']);
            const c = levelColors[level];
            return `
            <div class="price-card" style="border-left:4px solid ${c.border};">
                <div class="price-card-info">
                    <div class="price-card-name">${r['Item Name'] || r['SKU'] || 'Item'}</div>
                </div>
                <div class="price-card-actions">
                    <div class="price-card-val" style="background:${c.bg}; color:${c.text};">${stock}</div>
                </div>
            </div>
            `;
        }).join('');
    }

    function filterStockTab() {
        const q = document.getElementById('stockSearch').value.toLowerCase();
        const filtered = rawInventory.filter(r =>
            (r['Item Name'] || '').toLowerCase().includes(q) ||
            (r['SKU'] || '').toLowerCase().includes(q)
        );
        renderStockTab(filtered);
    }

    function toggleStockLowFilter() {
        stockShowLowOnly = !stockShowLowOnly;
        const btn = document.getElementById('stockLowFilterBtn');
        if (btn) btn.innerText = stockShowLowOnly ? '✅ Show All' : '⚠️ What to Stock';
        filterStockTab();
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
                itemStats[itemName].totalQty += (parseFloat(i['Quantity']) || 1);
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
        activeDraftOrderId = null;
        document.getElementById('orderFormCustMeta').innerText = `${custName} (📱 +91 ${mobile})`;
        document.getElementById('saveOrderFormEditBtn').style.display = 'none';
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

    async function sendOrderToWhatsApp() {
        if (!activeOrderCustomer || !cartItems.length) {
            alert('Please add at least one item to the order.');
            return;
        }
        const message = buildWhatsAppOrderMessage('🛒 *NEW ORDER - GO-KIRANA*', activeOrderCustomer.custName, activeOrderCustomer.mobile, cartItems);
        window.open(`https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`, '_blank');

        const ok = await persistDraftOrder({
            customerId: activeOrderCustomer.custId,
            customerName: activeOrderCustomer.custName,
            customerMobile: activeOrderCustomer.mobile,
            items: cartItems
        });
        if (!ok) {
            alert('⚠️ WhatsApp message sent, but saving to Draft Orders failed. Please retry.');
        }
    }

    // Saves the currently-open draft's changes without opening WhatsApp —
    // only shown (see editDraftOrderEntry) while actively editing an
    // existing draft, i.e. activeDraftOrderId is already set.
    async function saveOrderFormEdit() {
        if (!activeOrderCustomer || !cartItems.length) {
            alert('Please add at least one item to the order.');
            return;
        }
        const ok = await persistDraftOrder({
            customerId: activeOrderCustomer.custId,
            customerName: activeOrderCustomer.custName,
            customerMobile: activeOrderCustomer.mobile,
            items: cartItems
        });
        if (ok) {
            closeModal('orderFormModal');
        } else {
            alert('⚠️ Failed to save changes. Please try again.');
        }
    }

    // Creates/updates the shared Draft Orders row for the current cart —
    // used both after a WhatsApp send (where failure here is non-blocking,
    // since WhatsApp already opened) and by the "Save Changes" buttons
    // (where failure must NOT be treated as success). Returns true/false
    // rather than alerting itself, since the right failure message differs
    // by caller.
    async function persistDraftOrder(payload) {
        try {
            if (activeDraftOrderId) {
                await GK.api.updateDraftOrder(Object.assign({ id: activeDraftOrderId }, payload));
            } else {
                await GK.api.createDraftOrder(payload);
            }
            activeDraftOrderId = null;
            await refreshDraftOrders();
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
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

    async function sendNewCustomerOrderToWhatsApp() {
        const name = document.getElementById('newCustName').value.trim();
        const mobile = document.getElementById('newCustMobile').value.trim();

        if (!name) { alert('Please enter the Shopkeeper Name.'); document.getElementById('newCustName').focus(); return; }
        if (!mobile) { alert('Please enter the Mobile Number.'); document.getElementById('newCustMobile').focus(); return; }
        if (!newOrderCartItems.length) { alert('Please add at least one item to the cart.'); return; }

        const message = buildWhatsAppOrderMessage('✨ *NEW CUSTOMER ORDER - GO-KIRANA*', name, mobile, newOrderCartItems);
        window.open(`https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`, '_blank');

        const ok = await persistDraftOrder({
            customerId: '',
            customerName: name,
            customerMobile: mobile,
            items: newOrderCartItems
        });
        if (!ok) {
            alert('⚠️ WhatsApp message sent, but saving to Draft Orders failed. Please retry.');
        }
    }

    // Saves the currently-open draft's changes without opening WhatsApp —
    // only shown (see editDraftOrderEntry) while actively editing an
    // existing draft, i.e. activeDraftOrderId is already set.
    async function saveNewOrderEdit() {
        const name = document.getElementById('newCustName').value.trim();
        const mobile = document.getElementById('newCustMobile').value.trim();
        if (!name) { alert('Please enter the Shopkeeper Name.'); document.getElementById('newCustName').focus(); return; }
        if (!mobile) { alert('Please enter the Mobile Number.'); document.getElementById('newCustMobile').focus(); return; }
        if (!newOrderCartItems.length) { alert('Please add at least one item to the cart.'); return; }

        const ok = await persistDraftOrder({
            customerId: '',
            customerName: name,
            customerMobile: mobile,
            items: newOrderCartItems
        });

        if (ok) {
            newOrderCartItems = [];
            document.getElementById('newCustName').value = '';
            document.getElementById('newCustMobile').value = '';
            document.getElementById('saveNewOrderEditBtn').style.display = 'none';
            renderNewOrderCart();
            switchTab('draftOrdersTab');
        } else {
            alert('⚠️ Failed to save changes. Please try again.');
        }
    }

    // Nav pill entry point for a brand-new "New Order" — resets any
    // in-progress edit of a draft so a subsequent WhatsApp send creates a
    // fresh draft instead of overwriting the one just left behind.
    function startFreshNewOrder() {
        activeDraftOrderId = null;
        newOrderCartItems = [];
        document.getElementById('newCustName').value = '';
        document.getElementById('newCustMobile').value = '';
        document.getElementById('saveNewOrderEditBtn').style.display = 'none';
        renderNewOrderCart();
        switchTab('newOrderTab');
    }

    // --- DRAFT ORDERS TAB (all agents' rows — server already returns
    // everything for role:'admin', no client-side ownership filtering) ---
    function renderDraftOrdersTab() {
        const container = document.getElementById('draftOrdersList');
        if (!container) return;
        document.getElementById('draftOrdersCount').innerText = `${draftOrders.length} Drafts`;

        if (!draftOrders.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No draft orders right now.</p>';
            return;
        }

        const sorted = draftOrders.slice().sort((a, b) => String(b['CreatedAt']).localeCompare(String(a['CreatedAt'])));

        container.innerHTML = sorted.map(d => {
            const id = d['Id'];
            let items = [];
            try { items = JSON.parse(d['ItemsJson'] || '[]'); } catch (e) { items = []; }
            const status = d['Status'] || 'Pending';

            return `
            <div class="order-card">
                <div class="order-card-header">
                    <div>
                        <div class="order-id">${id}</div>
                        <div class="order-date">👤 <strong>${d['CustomerName'] || 'Customer'}</strong> • 📱 ${d['CustomerMobile'] || ''}</div>
                        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">By ${d['CreatedBy'] || '?'} • ${items.length} item(s)</div>
                    </div>
                    <select onchange="updateDraftOrderStatus('${id}', this.value)" class="input-text-standard" style="font-size:0.8rem; padding:6px; width:auto;">
                        <option value="Pending" ${status === 'Pending' ? 'selected' : ''}>Pending</option>
                        <option value="Confirmed" ${status === 'Confirmed' ? 'selected' : ''}>Confirmed</option>
                        <option value="On Hold" ${status === 'On Hold' ? 'selected' : ''}>On Hold</option>
                    </select>
                </div>
                <div class="order-items-list open">
                    ${items.map(i => `
                    <div class="item-row">
                        <div class="item-name">${i.name}</div>
                        <div class="item-meta">Qty: ${i.qty}${i.unitPrice != null ? ` • ₹${Number(i.unitPrice).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ' • Price N/A'}</div>
                    </div>`).join('')}
                </div>
                <div class="card-actions" style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); text-align:right; display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
                    <button class="btn-analytics" onclick="sendDraftOrderToRecordOrder('${id}')">📤 Send to Record Order</button>
                    <button class="btn-analytics" onclick="openAssignAgentModal('${id}')">🔀 Assign</button>
                    <button class="btn-analytics" onclick="editDraftOrderEntry('${id}')">✏️ Edit</button>
                    <button class="btn-analytics" style="color:#ef4444;" onclick="deleteDraftOrderEntry('${id}')">🗑️ Delete</button>
                </div>
            </div>`;
        }).join('');
    }

    async function refreshDraftOrders() {
        draftOrders = await GK.api.getDraftOrders();
        renderDraftOrdersTab();
    }

    // --- ASSIGN TO ANOTHER AGENT --------------------------------------------
    // Reassigns ownership (CreatedBy) of a draft order to a different
    // agent, so it disappears from the current owner's list and shows up
    // in the new owner's Pending Orders instead. Operates on an explicit
    // id (not activeDraftOrderId) since it's triggered directly from the
    // card list, without needing to open the order for editing first.
    async function openAssignAgentModal(id) {
        assigningDraftOrderId = id;
        const select = document.getElementById('assignAgentSelect');
        select.innerHTML = '<option value="">Loading agents…</option>';
        document.getElementById('assignAgentModal').classList.add('active');

        try {
            const agents = await GK.api.getAgentList();
            const currentUser = (GK.api.currentUser() || '').toLowerCase();
            const options = agents
                .filter(a => a.role === 'agent' && a.username.toLowerCase() !== currentUser)
                .map(a => `<option value="${a.username}">${a.username}</option>`)
                .join('');
            select.innerHTML = '<option value="">— Choose an agent —</option>' + options;
        } catch (err) {
            select.innerHTML = '<option value="">Failed to load agents</option>';
            alert('⚠️ ' + (err.message || 'Failed to load agent list.'));
        }
    }

    async function confirmAssignAgent() {
        const chosen = document.getElementById('assignAgentSelect').value;
        if (!chosen || !assigningDraftOrderId) {
            alert('Please choose an agent.');
            return;
        }

        try {
            await GK.api.reassignDraftOrder({ id: assigningDraftOrderId, assignTo: chosen });
            closeModal('assignAgentModal');
            assigningDraftOrderId = null;
            await refreshDraftOrders();
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to reassign.'));
        }
    }

    async function updateDraftOrderStatus(id, status) {
        try {
            await GK.api.updateDraftOrder({ id, status });
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to update status.'));
        }
        await refreshDraftOrders();
    }

    function editDraftOrderEntry(id) {
        const draft = draftOrders.find(d => String(d['Id']) === String(id));
        if (!draft) return;

        activeDraftOrderId = id;
        let items = [];
        try { items = JSON.parse(draft['ItemsJson'] || '[]'); } catch (e) { items = []; }
        const normalizedItems = items.map(i => ({
            sku: i.sku || null,
            name: i.name,
            qty: i.qty || 1,
            unitPrice: i.unitPrice != null ? i.unitPrice : null,
            costPrice: i.costPrice || 0
        }));

        if (draft['CustomerId']) {
            activeOrderCustomer = { custId: draft['CustomerId'], custName: draft['CustomerName'], mobile: draft['CustomerMobile'] };
            cartItems = normalizedItems;
            document.getElementById('orderFormCustMeta').innerText = `${draft['CustomerName']} (📱 +91 ${draft['CustomerMobile'] || ''})`;
            document.getElementById('saveOrderFormEditBtn').style.display = 'block';
            renderCart();
            document.getElementById('orderFormModal').classList.add('active');
        } else {
            // Not the orderFormModal flow — clear any stale customer from a
            // previous Take Order session so a later save/send can't
            // mistakenly branch into that path with the wrong customer.
            activeOrderCustomer = null;
            newOrderCartItems = normalizedItems;
            document.getElementById('newCustName').value = draft['CustomerName'] || '';
            document.getElementById('newCustMobile').value = draft['CustomerMobile'] || '';
            document.getElementById('saveNewOrderEditBtn').style.display = 'block';
            renderNewOrderCart();
            switchTab('newOrderTab');
        }
    }

    async function deleteDraftOrderEntry(id) {
        if (!confirm('Delete this draft order? This cannot be undone.')) return;
        try {
            await GK.api.deleteDraftOrder({ id });
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to delete.'));
        }
        await refreshDraftOrders();
    }

    // Hands a draft off to Record Order for final submission. sessionStorage
    // is the handoff mechanism (not a hash query param) since the shell
    // router does an *exact* match against ROUTES.
    function sendDraftOrderToRecordOrder(id) {
        const draft = draftOrders.find(d => String(d['Id']) === String(id));
        if (!draft) return;
        let items = [];
        try { items = JSON.parse(draft['ItemsJson'] || '[]'); } catch (e) { items = []; }

        sessionStorage.setItem('gk_load_draft_order', JSON.stringify({
            id: draft['Id'],
            customerId: draft['CustomerId'] || '',
            customerName: draft['CustomerName'] || '',
            customerMobile: draft['CustomerMobile'] || '',
            items: items,
            createdBy: draft['CreatedBy'] || ''
        }));
        location.hash = '#/orders';
    }

    // --- AUDIT LOG TAB (read-only) ---
    function renderAuditLogTab(rows) {
        const container = document.getElementById('auditLogList');
        if (!container) return;

        if (!rows || !rows.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No audit log entries yet.</p>';
            return;
        }

        const sorted = rows.slice().sort((a, b) => String(b['Timestamp']).localeCompare(String(a['Timestamp'])));

        container.innerHTML = `
        <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead>
                <tr style="text-align:left; border-bottom:2px solid var(--border); color:var(--text-muted); text-transform:uppercase; font-size:0.7rem; letter-spacing:0.04em;">
                    <th style="padding:8px;">Time</th>
                    <th style="padding:8px;">User</th>
                    <th style="padding:8px;">Role</th>
                    <th style="padding:8px;">Action</th>
                    <th style="padding:8px;">Draft ID</th>
                    <th style="padding:8px;">Details</th>
                </tr>
            </thead>
            <tbody>
                ${sorted.map(r => `
                <tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:8px; white-space:nowrap;">${new Date(r['Timestamp']).toLocaleString('en-IN')}</td>
                    <td style="padding:8px;">${r['Username'] || ''}</td>
                    <td style="padding:8px;">${r['Role'] || ''}</td>
                    <td style="padding:8px; text-transform:capitalize;">${r['Action'] || ''}</td>
                    <td style="padding:8px; font-family:monospace;">${r['DraftOrderId'] || ''}</td>
                    <td style="padding:8px;">${r['Details'] || ''}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>`;
    }

    // --- MANAGE INVENTORY (add/restock, edit, remove) ----------------------
    // Reuses the same fuzzy product search (getMatchScore) as everywhere
    // else, but with its own dropdown/selection handler (rather than the
    // shared handleSearchSuggestInput/selectSuggestedProduct) since
    // selecting a product here needs to resolve a SKU and look up its
    // current Inventory row, not just fill a text field.
    function handleInventorySearchInput(inputEl) {
        const dropdown = document.getElementById('invItemDropdown');
        if (!dropdown) return;

        invSelectedSku = null;
        invSelectedName = null;
        const infoBox = document.getElementById('invSelectedItemInfo');
        if (infoBox) infoBox.style.display = 'none';
        const marginBox = document.getElementById('invMarginPreview');
        if (marginBox) marginBox.style.display = 'none';

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
            return `
            <div class="custom-suggest-item" onclick="selectInventorySearchItem('${sku.replace(/'/g, "\\'")}')">
                <span>${name}</span>
                <span style="color:var(--text-muted); font-size:0.75rem; font-family:monospace;">${sku}</span>
            </div>
            `;
        }).join('');

        dropdown.style.display = 'block';
    }

    function selectInventorySearchItem(sku) {
        const prod = rawProducts.find(p => (p['SKU'] || '').trim() === sku);
        if (!prod) return;
        const name = prod['Item Name'] || prod['Standard Name'] || sku;

        invSelectedSku = sku;
        invSelectedName = name;
        document.getElementById('invItemSearchInput').value = name;
        document.getElementById('invItemDropdown').style.display = 'none';

        const existing = rawInventory.find(r => String(r['SKU'] || '').trim() === sku);
        const infoBox = document.getElementById('invSelectedItemInfo');
        if (existing) {
            const stock = Number(existing['Stock']) || 0;
            infoBox.innerHTML = `✔ Already in inventory — current stock: <strong>${stock}</strong>. Submitting will add your entered Stock to this.`;

            // Pre-fill from the existing row so admin only has to tweak
            // Selling Price to dial in the margin, not re-type everything.
            document.getElementById('invCasePriceInput').value = toNum(existing['Case Price']) || '';
            document.getElementById('invUnitsInCaseInput').value = toNum(existing['Units in case'] ?? existing['Units In Case']) || '';
            document.getElementById('invSellingPriceInput').value = toNum(existing['Selling Price']) || '';
        } else {
            infoBox.innerHTML = `➕ Not yet in inventory — submitting will create a new Inventory row.`;
        }
        infoBox.style.display = 'block';
        updateInventoryMarginPreview();
    }

    // Mirrors the Inventory sheet's own formulas (Per Unit Price = Case
    // Price / Units in Case; Margin % = markup over that per-unit cost, not
    // over Selling Price — confirmed against real sheet rows) so what's
    // shown while typing matches what the sheet will compute once saved.
    // TARGET_MARGIN matches the 4% target already used in Inventory Guide.
    function updateInventoryMarginPreview() {
        const box = document.getElementById('invMarginPreview');
        if (!box) return;

        const casePrice = parseFloat(document.getElementById('invCasePriceInput').value);
        const unitsInCase = parseFloat(document.getElementById('invUnitsInCaseInput').value);
        const sellingPrice = parseFloat(document.getElementById('invSellingPriceInput').value);

        if (!(casePrice >= 0) || !(unitsInCase > 0) || isNaN(sellingPrice) || sellingPrice < 0) {
            box.style.display = 'none';
            return;
        }

        const TARGET_MARGIN = 4.0;
        const perUnitCost = casePrice / unitsInCase;
        const margin = perUnitCost > 0 ? ((sellingPrice - perUnitCost) / perUnitCost) * 100 : 0;

        let color = '#ef4444'; // loss
        if (margin >= TARGET_MARGIN) color = '#10b981'; // at/above target
        else if (margin >= 0) color = '#d97706'; // positive but below target

        box.innerHTML = `Cost per unit: <strong>₹${perUnitCost.toLocaleString('en-IN', {maximumFractionDigits:2})}</strong>
            &nbsp;•&nbsp; Margin: <strong style="color:${color};">${margin.toLocaleString('en-IN', {maximumFractionDigits:2})}%</strong>
            ${margin < TARGET_MARGIN ? `<span style="color:var(--text-muted); font-size:0.78rem;"> (target ${TARGET_MARGIN}%+)</span>` : ''}`;
        box.style.display = 'block';
    }

    // Adds the currently-filled item to the local queue rather than
    // submitting immediately — lets admin build up a whole restock batch
    // (search, fill, add, repeat) before sending it all in one request via
    // submitInventoryQueue(), instead of one round trip per item.
    function addInventoryQueueItem() {
        if (!invSelectedSku) { alert('Please search and select a product first.'); return; }

        const stock = parseFloat(document.getElementById('invStockInput').value);
        const casePrice = parseFloat(document.getElementById('invCasePriceInput').value);
        const unitsInCase = parseFloat(document.getElementById('invUnitsInCaseInput').value);
        const sellingPrice = parseFloat(document.getElementById('invSellingPriceInput').value);

        if (!(stock > 0)) { alert('Please enter a valid Stock quantity.'); return; }
        if (isNaN(casePrice) || casePrice < 0) { alert('Please enter a valid Case Price.'); return; }
        if (!(unitsInCase > 0)) { alert('Please enter valid Units in Case.'); return; }
        if (isNaN(sellingPrice) || sellingPrice < 0) { alert('Please enter a valid Selling Price.'); return; }

        bulkInventoryQueue.push({
            sku: invSelectedSku,
            itemName: invSelectedName,
            stock: stock,
            casePrice: casePrice,
            unitsInCase: unitsInCase,
            sellingPrice: sellingPrice
        });

        document.getElementById('invItemSearchInput').value = '';
        document.getElementById('invStockInput').value = '';
        document.getElementById('invCasePriceInput').value = '';
        document.getElementById('invUnitsInCaseInput').value = '';
        document.getElementById('invSellingPriceInput').value = '';
        document.getElementById('invSelectedItemInfo').style.display = 'none';
        document.getElementById('invMarginPreview').style.display = 'none';
        invSelectedSku = null;
        invSelectedName = null;

        renderInventoryQueue();
        document.getElementById('invItemSearchInput').focus();
    }

    function renderInventoryQueue() {
        const container = document.getElementById('invQueueList');
        const countEl = document.getElementById('invQueueCount');
        const submitBtn = document.getElementById('invQueueSubmitBtn');
        if (!container) return;

        countEl.innerText = `${bulkInventoryQueue.length} Item(s)`;
        submitBtn.disabled = !bulkInventoryQueue.length;

        if (!bulkInventoryQueue.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No items added yet.</p>';
            return;
        }

        container.innerHTML = bulkInventoryQueue.map((item, idx) => {
            const existing = rawInventory.find(r => String(r['SKU'] || '').trim() === item.sku);
            const stockNote = existing
                ? `+${item.stock} (currently ${toNum(existing['Stock'])} in stock)`
                : `new item — stock ${item.stock}`;
            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <div>
                    <strong>${item.itemName}</strong>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${stockNote} • ₹${item.casePrice}/case (${item.unitsInCase}/case) • sell ₹${item.sellingPrice}</div>
                </div>
                <button onclick="removeInventoryQueueItem(${idx})" style="border:none; background:none; color:red; font-weight:bold; cursor:pointer; font-size:1rem;">✕</button>
            </div>`;
        }).join('');
    }

    function removeInventoryQueueItem(idx) {
        bulkInventoryQueue.splice(idx, 1);
        renderInventoryQueue();
    }

    // Submits the whole queue in ONE request (bulkAddInventoryStock) rather
    // than firing one request per item — avoids recreating the exact
    // "many simultaneous Apps Script requests" reliability problem that was
    // just fixed elsewhere in this app.
    async function submitInventoryQueue() {
        if (!bulkInventoryQueue.length) return;

        const submitBtn = document.getElementById('invQueueSubmitBtn');
        const originalLabel = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '⏳ Submitting...';

        try {
            await GK.api.bulkAddInventoryStock({ items: bulkInventoryQueue });
            bulkInventoryQueue = [];
            renderInventoryQueue();
            await refreshInventoryMgmt();
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to submit inventory list.'));
            submitBtn.disabled = false;
        } finally {
            submitBtn.innerHTML = originalLabel;
        }
    }

    async function refreshInventoryMgmt() {
        rawInventory = await GK.api.getSheet('Inventory', { force: true });
        renderInventoryMgmtList(rawInventory);
    }

    function filterInventoryMgmt() {
        const q = document.getElementById('invMgmtSearch').value.toLowerCase();
        const filtered = rawInventory.filter(r =>
            (r['Item Name'] || '').toLowerCase().includes(q) ||
            (r['SKU'] || '').toLowerCase().includes(q)
        );
        renderInventoryMgmtList(filtered);
    }

    function renderInventoryMgmtList(rows) {
        const container = document.getElementById('invMgmtList');
        if (!container) return;
        document.getElementById('invMgmtCount').innerText = `${rows.length} Items`;

        if (!rows.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No inventory items yet.</p>';
            return;
        }

        // Rendered twice — a table for wide screens, cards for phone — with
        // CSS (.inv-table-view / .inv-card-view) deciding which is visible,
        // so switching doesn't need a resize-triggered re-render.
        container.innerHTML = `
        <div class="inv-table-view" style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead>
                <tr style="text-align:left; border-bottom:2px solid var(--border); color:var(--text-muted); text-transform:uppercase; font-size:0.7rem; letter-spacing:0.04em;">
                    <th style="padding:8px;">Item</th>
                    <th style="padding:8px;">SKU</th>
                    <th style="padding:8px; text-align:right;">Stock</th>
                    <th style="padding:8px; text-align:right;">Case Price</th>
                    <th style="padding:8px; text-align:right;">Units/Case</th>
                    <th style="padding:8px; text-align:right;">Per Unit</th>
                    <th style="padding:8px; text-align:right;">Selling Price</th>
                    <th style="padding:8px; text-align:right;">Margin</th>
                    <th style="padding:8px; text-align:right;">Current Asset</th>
                    <th style="padding:8px;"></th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(r => {
                    const sku = String(r['SKU'] || '').trim();
                    const stock = toNum(r['Stock']);
                    const unitsInCase = r['Units in case'] ?? r['Units In Case'] ?? '';
                    return `
                    <tr style="border-bottom:1px solid var(--border);">
                        <td style="padding:8px; font-weight:700;">${r['Item Name'] || ''}</td>
                        <td style="padding:8px; font-family:monospace; font-size:0.75rem; color:var(--text-muted);">${sku}</td>
                        <td style="padding:8px; text-align:right; font-weight:700; ${stock < 0 ? 'color:#ef4444;' : ''}">${stock}</td>
                        <td style="padding:8px; text-align:right;">₹${toNum(r['Case Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                        <td style="padding:8px; text-align:right;">${unitsInCase}</td>
                        <td style="padding:8px; text-align:right;">₹${toNum(r['Per Unit Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                        <td style="padding:8px; text-align:right;">₹${toNum(r['Selling Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                        <td style="padding:8px; text-align:right;">${r['Margin'] !== undefined && r['Margin'] !== '' ? r['Margin'] : '—'}</td>
                        <td style="padding:8px; text-align:right;">₹${toNum(r['Current Asset']).toLocaleString('en-IN', {maximumFractionDigits:2})}</td>
                        <td style="padding:8px; text-align:right; white-space:nowrap;">
                            <button class="btn-analytics" onclick="editInventoryItem('${sku.replace(/'/g, "\\'")}')">✏️</button>
                            <button class="btn-analytics" style="color:#ef4444;" onclick="deleteInventoryItemPrompt('${sku.replace(/'/g, "\\'")}')">🗑️</button>
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>
        <div class="inv-card-view">
            ${rows.map(r => {
                const sku = String(r['SKU'] || '').trim();
                const stock = toNum(r['Stock']);
                const unitsInCase = r['Units in case'] ?? r['Units In Case'] ?? '';
                return `
                <div class="inv-item-card">
                    <div class="inv-item-card-header">
                        <div>
                            <div class="inv-item-card-name">${r['Item Name'] || ''}</div>
                            <div class="inv-item-card-sku">${sku}</div>
                        </div>
                        <strong style="font-size:1rem; ${stock < 0 ? 'color:#ef4444;' : ''}">${stock}</strong>
                    </div>
                    <div class="inv-item-card-grid">
                        <div><span>Case Price</span><strong>₹${toNum(r['Case Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</strong></div>
                        <div><span>Units/Case</span><strong>${unitsInCase}</strong></div>
                        <div><span>Per Unit</span><strong>₹${toNum(r['Per Unit Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</strong></div>
                        <div><span>Selling Price</span><strong>₹${toNum(r['Selling Price']).toLocaleString('en-IN', {maximumFractionDigits:2})}</strong></div>
                        <div><span>Margin</span><strong>${r['Margin'] !== undefined && r['Margin'] !== '' ? r['Margin'] : '—'}</strong></div>
                        <div><span>Current Asset</span><strong>₹${toNum(r['Current Asset']).toLocaleString('en-IN', {maximumFractionDigits:2})}</strong></div>
                    </div>
                    <div class="inv-item-card-actions">
                        <button class="btn-analytics" onclick="editInventoryItem('${sku.replace(/'/g, "\\'")}')">✏️ Edit</button>
                        <button class="btn-analytics" style="color:#ef4444;" onclick="deleteInventoryItemPrompt('${sku.replace(/'/g, "\\'")}')">🗑️ Delete</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    }

    function editInventoryItem(sku) {
        const row = rawInventory.find(r => String(r['SKU'] || '').trim() === sku);
        if (!row) return;

        editingInventorySku = sku;
        document.getElementById('editInvItemName').innerText = row['Item Name'] || sku;
        document.getElementById('editInvItemSku').innerText = `SKU: ${sku}`;
        document.getElementById('editInvStock').value = toNum(row['Stock']);
        document.getElementById('editInvCasePrice').value = toNum(row['Case Price']);
        document.getElementById('editInvUnitsInCase').value = toNum(row['Units in case'] ?? row['Units In Case']);
        document.getElementById('editInvSellingPrice').value = toNum(row['Selling Price']);
        document.getElementById('editInventoryModal').classList.add('active');
    }

    async function saveInventoryItemEdit() {
        if (!editingInventorySku) return;

        try {
            await GK.api.updateInventoryItem({
                sku: editingInventorySku,
                stock: parseFloat(document.getElementById('editInvStock').value) || 0,
                casePrice: parseFloat(document.getElementById('editInvCasePrice').value) || 0,
                unitsInCase: parseFloat(document.getElementById('editInvUnitsInCase').value) || 0,
                sellingPrice: parseFloat(document.getElementById('editInvSellingPrice').value) || 0
            });
            editingInventorySku = null;
            closeModal('editInventoryModal');
            await refreshInventoryMgmt();
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to update inventory item.'));
        }
    }

    async function deleteInventoryItemPrompt(sku) {
        const row = rawInventory.find(r => String(r['SKU'] || '').trim() === sku);
        if (!confirm(`Delete "${row ? row['Item Name'] : sku}" from Inventory? This cannot be undone.`)) return;

        try {
            await GK.api.deleteInventoryItem({ sku });
            await refreshInventoryMgmt();
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to delete inventory item.'));
        }
    }

    // --- ADD PRODUCTS (bulk add/update to the Products catalog) -----------
    // Item Category / Unit of Measurement / Packaging Type accept free text
    // but suggest whatever values already exist in the live sheet, via
    // <datalist> — real usage, not a guessed fixed list.
    function renderProductDatalists() {
        const categories = [...new Set(rawProducts.map(p => (p['Item Category'] || '').trim()).filter(Boolean))].sort();
        const uoms = [...new Set(rawProducts.map(p => (p['Unit of Measurement'] || '').trim()).filter(Boolean))].sort();
        const packagingTypes = [...new Set(rawProducts.map(p => (p['Packaging Type'] || '').trim()).filter(Boolean))].sort();

        const toOptions = list => list.map(v => `<option value="${v.replace(/"/g, '&quot;')}">`).join('');
        document.getElementById('productCategoryList').innerHTML = toOptions(categories);
        document.getElementById('uomList').innerHTML = toOptions(uoms);
        document.getElementById('packagingTypeList').innerHTML = toOptions(packagingTypes);

        // SKU suggestions show the item name as the visible label (option
        // value is the SKU actually filled in) so admin can find a product
        // by name without needing to know its SKU by heart.
        document.getElementById('existingSkuList').innerHTML = rawProducts
            .filter(p => (p['SKU'] || '').trim())
            .map(p => `<option value="${String(p['SKU']).trim().replace(/"/g, '&quot;')}">${(p['Item Name'] || '').replace(/</g, '&lt;')}</option>`)
            .join('');
    }

    // Live SKU lookup as admin fills the form — mirrors the Inventory tool's
    // "already in inventory" check: if the SKU already exists in Products,
    // pre-fill the rest of the form from its current values (so admin edits
    // in place instead of retyping) and make clear this will UPDATE it
    // rather than create a duplicate.
    function checkProductSku() {
        const sku = document.getElementById('prodSkuInput').value.trim();
        const infoBox = document.getElementById('prodSkuInfo');
        if (!sku) { infoBox.style.display = 'none'; return; }

        const existing = rawProducts.find(p => (p['SKU'] || '').trim() === sku);
        if (existing) {
            infoBox.innerHTML = "✔ SKU already exists — submitting will update this product's details (fields below pre-filled from its current values).";
            document.getElementById('prodItemNameInput').value = existing['Item Name'] || '';
            document.getElementById('prodStandardNameInput').value = existing['Standard Name'] || '';
            document.getElementById('prodCategoryInput').value = existing['Item Category'] || '';
            document.getElementById('prodUomInput').value = existing['Unit of Measurement'] || '';
            document.getElementById('prodPackagingInput').value = existing['Packaging Type'] || '';
            document.getElementById('prodUnitsPerPackageInput').value = existing['Units per Package'] || '';
            document.getElementById('prodPricePerUnitInput').value = existing['Price per Unit'] || '';
            document.getElementById('prodActualPriceInput').value = existing['Actual Price'] || '';
            document.getElementById('prodMrpInput').value = existing['MRP'] || '';
            document.getElementById('prodSearchKeywordsInput').value = existing['Search Keywords'] || '';
        } else {
            infoBox.innerHTML = '➕ New SKU — submitting will create a new product.';
        }
        infoBox.style.display = 'block';
    }

    const PRODUCT_FORM_FIELD_IDS = [
        'prodSkuInput', 'prodItemNameInput', 'prodStandardNameInput',
        'prodCategoryInput', 'prodUomInput', 'prodPackagingInput',
        'prodUnitsPerPackageInput', 'prodPricePerUnitInput', 'prodActualPriceInput',
        'prodMrpInput', 'prodSearchKeywordsInput'
    ];

    function addProductQueueItem() {
        const sku = document.getElementById('prodSkuInput').value.trim();
        const itemName = document.getElementById('prodItemNameInput').value.trim();
        if (!sku) { alert('Please enter a SKU.'); return; }
        if (!itemName) { alert('Please enter an Item Name.'); return; }

        productQueue.push({
            sku: sku,
            itemName: itemName,
            standardName: document.getElementById('prodStandardNameInput').value.trim(),
            itemCategory: document.getElementById('prodCategoryInput').value.trim(),
            unitOfMeasurement: document.getElementById('prodUomInput').value.trim(),
            packagingType: document.getElementById('prodPackagingInput').value.trim(),
            unitsPerPackage: parseFloat(document.getElementById('prodUnitsPerPackageInput').value) || 0,
            pricePerUnit: parseFloat(document.getElementById('prodPricePerUnitInput').value) || 0,
            actualPrice: parseFloat(document.getElementById('prodActualPriceInput').value) || 0,
            mrp: parseFloat(document.getElementById('prodMrpInput').value) || 0,
            searchKeywords: document.getElementById('prodSearchKeywordsInput').value.trim()
        });

        PRODUCT_FORM_FIELD_IDS.forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('prodSkuInfo').style.display = 'none';

        renderProductQueue();
        document.getElementById('prodSkuInput').focus();
    }

    function renderProductQueue() {
        const container = document.getElementById('prodQueueList');
        const countEl = document.getElementById('prodQueueCount');
        const submitBtn = document.getElementById('prodQueueSubmitBtn');
        if (!container) return;

        countEl.innerText = `${productQueue.length} Item(s)`;
        submitBtn.disabled = !productQueue.length;

        if (!productQueue.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No items added yet.</p>';
            return;
        }

        container.innerHTML = productQueue.map((item, idx) => {
            const exists = rawProducts.some(p => (p['SKU'] || '').trim() === item.sku);
            const note = exists ? 'will update existing' : 'new product';
            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <div>
                    <strong>${item.itemName}</strong>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${item.sku} • ${note} • ₹${item.pricePerUnit}/unit</div>
                </div>
                <button onclick="removeProductQueueItem(${idx})" style="border:none; background:none; color:red; font-weight:bold; cursor:pointer; font-size:1rem;">✕</button>
            </div>`;
        }).join('');
    }

    function removeProductQueueItem(idx) {
        productQueue.splice(idx, 1);
        renderProductQueue();
    }

    async function submitProductQueue() {
        if (!productQueue.length) return;

        const submitBtn = document.getElementById('prodQueueSubmitBtn');
        const originalLabel = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '⏳ Submitting...';

        try {
            await GK.api.bulkAddProducts({ items: productQueue });
            productQueue = [];
            renderProductQueue();
            await refreshProductsAfterAdd();
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to submit product list.'));
            submitBtn.disabled = false;
        } finally {
            submitBtn.innerHTML = originalLabel;
        }
    }

    // Narrower than a full fetchLiveData() — Products feeds the search/price
    // map used all over this view, so refresh just that sheet and the
    // views/state derived from it, not everything.
    async function refreshProductsAfterAdd() {
        rawProducts = await GK.api.getSheet('Products', { force: true });

        productMapBySKU = {};
        productMapByNameAndPrice = {};
        rawProducts.forEach(p => {
            const sku = (p['SKU'] || '').trim();
            const name = p['Item Name'] || p['Standard Name'] || sku;
            const price = parseFloat(p['Price per Unit'] || 0);
            const costPrice = parseFloat(p['Cost Price'] || p['Actual Price'] || p['Cost'] || p['Purchase Price'] || 0);
            if (sku) {
                productMapBySKU[sku] = { sku, name, price, costPrice };
                const suggestionLabel = `${name} - ₹${price}`;
                productMapByNameAndPrice[suggestionLabel.toLowerCase()] = { sku, name, price, costPrice };
            }
        });

        renderPriceList(rawProducts);
        renderProductDatalists();
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
        warmBillPdfLibs(); // fire-and-forget: have jsPDF/html2canvas cached before "Send via WhatsApp" is clicked
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
                <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); text-align:right; display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
                    <button class="btn-analytics" onclick="viewOrderBill('${orderId}')">🧾 View Bill</button>
                    <button class="btn-whatsapp" onclick="shareBillOnWhatsApp('${orderId}', this)">📲 Send via WhatsApp</button>
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
            const qty = parseFloat(it['Quantity']) || 0;
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

                <div class="return-policy">
                    <div class="return-policy-en">Returns are accepted within 48 hours of purchase. Returns will not be accepted after this period.</div>
                    <div class="return-policy-hi">उत्पाद खरीद की तारीख से 48 घंटे के भीतर वापस किए जा सकते हैं। इस अवधि के बाद वापसी स्वीकार नहीं की जाएगी।</div>
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
    .bill-render-scope {
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

    .return-policy { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; text-align: center; }
    .return-policy-en { font-size: 0.78rem; font-weight: 600; color: var(--navy); }
    .return-policy-hi { font-size: 0.78rem; font-weight: 600; color: var(--navy); margin-top: 2px; }

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
<body class="bill-render-scope">
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

    // --- SEND BILL VIA WHATSAPP (real PDF, native share sheet) ------------
    // There's no actual PDF anywhere in the app today — "View Bill" just
    // opens the print-ready HTML (buildBillSection/wrapBillDocument) in a
    // new tab. To hand the customer a real file over WhatsApp, that same
    // HTML is rendered off-screen with html2canvas and the resulting image
    // is wrapped in a jsPDF document. Both libraries are pulled from a CDN
    // lazily on first use — not part of the app shell/service-worker
    // precache — so views that never touch billing pay nothing for them.
    //
    // An earlier version rendered into a hidden <iframe srcdoc="..."> and
    // loaded html2canvas into that iframe's own window — this looked clean
    // but was unreliable in practice (some browsers/network conditions
    // fail to load a script injected into a srcdoc document). Rendering
    // straight into the main document instead uses the exact same
    // script-loading path already proven to work for jsPDF.
    let _billPdfLibsPromise = null;
    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Could not load ' + src));
            document.head.appendChild(s);
        });
    }
    function loadBillPdfLibs() {
        if (!_billPdfLibsPromise) {
            _billPdfLibsPromise = Promise.all([
                loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
                loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js')
            ]);
        }
        return _billPdfLibsPromise;
    }

    // navigator.share() only works while a user gesture's "activation" is
    // still live, and generating the PDF (loading libraries + rendering a
    // canvas) takes real time — on a first-ever share, fetching those
    // libraries fresh from the CDN could eat enough of that window to make
    // the share silently fail. Loading both as soon as the Orders stream
    // renders (well before any click) means by the time someone actually
    // presses "Send via WhatsApp", they're already cached.
    function warmBillPdfLibs() {
        loadBillPdfLibs().catch(() => {});
    }

    // Bill CSS (the <style> block inside wrapBillDocument) is scoped under
    // a .bill-render-scope class rather than :root specifically so it can
    // be safely injected into the app shell's own document here without
    // its --navy/--bg/--border/... variables leaking into the app's theme.
    function ensureBillStylesInjected() {
        if (document.getElementById('billPdfStyles')) return;
        const doc = new DOMParser().parseFromString(wrapBillDocument('', ''), 'text/html');
        const style = document.createElement('style');
        style.id = 'billPdfStyles';
        style.textContent = doc.querySelector('style').textContent;
        document.head.appendChild(style);
    }

    // Renders one bill (the exact markup "View Bill" uses) into a hidden,
    // off-screen node in the current document so html2canvas can photograph
    // fully laid-out, correctly-styled markup.
    async function renderBillToCanvas(sectionsHtml) {
        ensureBillStylesInjected();
        const holder = document.createElement('div');
        holder.className = 'bill-render-scope';
        holder.style.cssText = 'position:fixed; top:-10000px; left:-10000px; width:800px; background:#F4F7F6; padding:24px;';
        holder.innerHTML = sectionsHtml;
        document.body.appendChild(holder);
        try {
            const target = holder.querySelector('.bill-card');
            return await html2canvas(target, { scale: 2, backgroundColor: '#ffffff' });
        } finally {
            document.body.removeChild(holder);
        }
    }

    async function buildBillPdfBlob(orderId) {
        const order = billOrderById(orderId);
        if (!order) throw new Error('Order not found.');
        const items = billItemsForOrder(orderId);

        await loadBillPdfLibs();
        const canvas = await renderBillToCanvas(buildBillSection(order, items));
        const imgData = canvas.toDataURL('image/jpeg', 0.92);

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ unit: 'px', format: [canvas.width, canvas.height] });
        pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width, canvas.height);
        return pdf.output('blob');
    }

    // navigator.share with a File is the only web API that hands another
    // app (WhatsApp) an actual file — there's no way to deep-link straight
    // into a specific WhatsApp chat AND attach a file at once, so this opens
    // the phone's native share sheet (same one "Share" uses anywhere else)
    // and the admin picks WhatsApp + the customer's chat from there. Falls
    // back to downloading the PDF + opening a wa.me chat with just the
    // caption on browsers that can't share files (mainly desktop).
    async function shareBillOnWhatsApp(orderId, btnEl) {
        const order = billOrderById(orderId);
        if (!order) { alert('Order not found.'); return; }

        const originalLabel = btnEl ? btnEl.innerHTML : null;
        if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '⏳ Preparing...'; }

        const caption = `Here is your bill 🧾 — Order ${orderId}. Thank you for shopping with Go-Kirana!`;

        try {
            const blob = await buildBillPdfBlob(orderId);
            const file = new File([blob], `GoKirana-Bill-${orderId}.pdf`, { type: 'application/pdf' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], text: caption, title: `Go-Kirana Bill ${orderId}` });
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `GoKirana-Bill-${orderId}.pdf`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 30000);

                const custContact = billCustomerContact(order);
                const waNum = custContact ? custContact.replace(/[^0-9]/g, '') : '';
                const waUrl = `https://wa.me/${waNum}?text=${encodeURIComponent(caption)}`;
                window.open(waUrl, '_blank');
                alert('📄 Bill PDF downloaded — your browser can\'t hand a file straight to WhatsApp, so attach the downloaded file in the chat that just opened.');
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return; // admin cancelled the native share sheet
            alert('⚠️ Failed to prepare the bill for sharing: ' + (err.message || err));
        } finally {
            if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalLabel; }
        }
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
            const qty = parseFloat(i['Quantity'])||0;
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
        filterStockTab,
        toggleStockLowFilter,
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
        shareBillOnWhatsApp,
        updateDayWiseBillsSummary,
        generateDayWiseBills,
        startFreshNewOrder,
        updateDraftOrderStatus,
        editDraftOrderEntry,
        deleteDraftOrderEntry,
        sendDraftOrderToRecordOrder,
        saveOrderFormEdit,
        saveNewOrderEdit,
        openAssignAgentModal,
        confirmAssignAgent,
        handleInventorySearchInput,
        selectInventorySearchItem,
        updateInventoryMarginPreview,
        addInventoryQueueItem,
        removeInventoryQueueItem,
        submitInventoryQueue,
        filterInventoryMgmt,
        editInventoryItem,
        saveInventoryItemEdit,
        deleteInventoryItemPrompt,
        checkProductSku,
        addProductQueueItem,
        removeProductQueueItem,
        submitProductQueue
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call fetchLiveData() here, or every navigation double-fetches.
    window.GK_viewInit = () => fetchLiveData(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
