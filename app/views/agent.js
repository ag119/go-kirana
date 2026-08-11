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

    // Draft Orders (sheet-backed): agent's own WhatsApp-submitted requests,
    // awaiting admin review/finalization. activeDraftOrderId tracks which
    // one (if any) the order-taking flow is currently editing — must be
    // reset to null whenever a *fresh* order is started (openOrderForm /
    // startFreshNewOrder), otherwise submitting a different/new order would
    // silently update the previously-edited draft instead of creating one.
    let draftOrders = [];
    let activeDraftOrderId = null;
    let rawInventory = [];
    let assigningDraftOrderId = null;

    // --- DATA FETCHING (via Apps Script proxy — no sheet ID/gviz here) ---
    // force=true bypasses the shared localStorage cache (see app/assets/api.js) —
    // used by the shell's Refresh button. Plain navigation reuses cached data.
    async function fetchLiveData(force) {
        const status = document.getElementById('status-banner');
        status.className = 'status-loading';
        status.innerHTML = '📡 Syncing real-time store data...';

        try {
            // One batched request for all sheet tabs instead of N separate
            // ones — each doPost independently reopens the spreadsheet and
            // Apps Script has real concurrency limits, so firing many at
            // once was the main source of "connection error, works on
            // retry". getDraftOrders() stays separate since it has its own
            // (never-cached, per-user-filtered) semantics.
            const [sheets, drafts] = await Promise.all([
                GK.api.getSheets(['Customers', 'Orders', 'Order Details', 'Products', 'Inventory'], { force }),
                GK.api.getDraftOrders()
            ]);

            rawCustomers = sheets['Customers'] || [];
            rawOrders = sheets['Orders'] || [];
            rawOrderItems = sheets['Order Details'] || [];
            rawProducts = sheets['Products'] || [];
            draftOrders = drafts;
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
            renderCustomersGrid(processedCustomers);
            renderFollowupGrid();
            renderPriceList(rawProducts);
            filterStockTab();
            renderOrdersStream(rawOrders);
            renderPendingOrdersTab();

            status.className = 'status-success';
            status.innerHTML = `✅ Store synced live at ${new Date().toLocaleTimeString()}`;
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

    // Combined quantity needed across all currently-visible pending orders,
    // by SKU — an item can be flagged before it hits zero if what's already
    // been requested would use up more than what's on hand.
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
        const stock = Number(row['Stock']) || 0;
        const unitsInCase = Number(row['Units in case'] ?? row['Units In Case']) || 0;
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
            const stock = Number(r['Stock']) || 0;
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

                if (!itemStats[itemName]) {
                    itemStats[itemName] = { totalQty: 0, orderAppearances: 0, lastOrderIndex: orderIndex };
                }

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

    async function sendOrderToWhatsApp() {
        if (!activeOrderCustomer || !cartItems.length) {
            alert('Please add at least one item to the order.');
            return;
        }

        const message = buildWhatsAppOrderMessage('🛒 *NEW ORDER - GO-KIRANA*', activeOrderCustomer.custName, activeOrderCustomer.mobile, cartItems);
        const waUrl = `https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank');

        const ok = await persistDraftOrder({
            customerId: activeOrderCustomer.custId,
            customerName: activeOrderCustomer.custName,
            customerMobile: activeOrderCustomer.mobile,
            items: cartItems
        });
        if (!ok) {
            alert('⚠️ WhatsApp message sent, but saving to Pending Orders failed. Please retry or let admin know.');
        }
    }

    // Saves the currently-open pending order's changes without opening
    // WhatsApp — only shown (see editPendingOrder) while actively editing
    // an existing draft, i.e. activeDraftOrderId is already set.
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
    // (where failure must NOT be treated as success, so the caller can
    // decide what to do next). Returns true/false rather than alerting
    // itself, since the right failure message differs by caller.
    async function persistDraftOrder(payload) {
        try {
            if (activeDraftOrderId) {
                await GK.api.updateDraftOrder(Object.assign({ id: activeDraftOrderId }, payload));
            } else {
                await GK.api.createDraftOrder(payload);
            }
            activeDraftOrderId = null;
            draftOrders = await GK.api.getDraftOrders();
            renderPendingOrdersTab();
            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
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

    async function sendNewCustomerOrderToWhatsApp() {
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

        const ok = await persistDraftOrder({
            customerId: '',
            customerName: name,
            customerMobile: mobile,
            items: newOrderCartItems
        });
        if (!ok) {
            alert('⚠️ WhatsApp message sent, but saving to Pending Orders failed. Please retry or let admin know.');
        }
    }

    // Saves the currently-open pending order's changes without opening
    // WhatsApp — only shown (see editPendingOrder) while actively editing
    // an existing draft, i.e. activeDraftOrderId is already set.
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
            switchTab('pendingOrdersTab');
        } else {
            alert('⚠️ Failed to save changes. Please try again.');
        }
    }

    // Nav pill / home card entry point for a brand-new "New Order" — resets
    // any in-progress edit of a pending draft so a subsequent WhatsApp send
    // creates a fresh draft instead of overwriting the one just left behind.
    function startFreshNewOrder() {
        activeDraftOrderId = null;
        newOrderCartItems = [];
        document.getElementById('newCustName').value = '';
        document.getElementById('newCustMobile').value = '';
        document.getElementById('saveNewOrderEditBtn').style.display = 'none';
        renderNewOrderCart();
        switchTab('newOrderTab');
    }

    // --- PENDING ORDERS TAB (agent's own Draft Orders rows) ---
    function renderPendingOrdersTab() {
        const container = document.getElementById('pendingOrdersList');
        if (!container) return;
        document.getElementById('pendingOrdersCount').innerText = `${draftOrders.length} Pending`;

        if (!draftOrders.length) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px;">No pending orders. Orders you submit via WhatsApp will appear here.</p>';
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
                        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">${items.length} item(s)</div>
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
                    <button class="btn-analytics" onclick="openAssignAgentModal('${id}')">🔀 Assign</button>
                    <button class="btn-analytics" onclick="editPendingOrder('${id}')">✏️ Edit</button>
                    <button class="btn-analytics" style="color:#ef4444;" onclick="deletePendingOrder('${id}')">🗑️ Delete</button>
                </div>
            </div>`;
        }).join('');
    }

    async function refreshPendingOrders() {
        draftOrders = await GK.api.getDraftOrders();
        renderPendingOrdersTab();
    }

    // --- ASSIGN TO ANOTHER AGENT --------------------------------------------
    // Reassigns ownership (CreatedBy) of a pending order to a different
    // agent, so it disappears from this agent's Pending Orders and shows up
    // in the new owner's instead. Operates on an explicit id (not
    // activeDraftOrderId) since it's triggered directly from the card list,
    // without needing to open the order for editing first.
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
            await refreshPendingOrders();
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
        await refreshPendingOrders();
    }

    function editPendingOrder(id) {
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

    async function deletePendingOrder(id) {
        if (!confirm('Delete this pending order? This cannot be undone.')) return;
        try {
            await GK.api.deleteDraftOrder({ id });
        } catch (err) {
            alert('⚠️ ' + (err.message || 'Failed to delete.'));
        }
        await refreshPendingOrders();
    }

    // --- SHOPPING LIST: item-wise totals across every Pending Order,
    // cross-checked against Inventory stock, so an agent can see at a
    // glance what still needs to be bought at the market before heading
    // out — vs what's already covered by what's in stock. ---
    function computePendingOrdersRequirement() {
        const map = {};
        draftOrders.forEach(draft => {
            let items = [];
            try { items = JSON.parse(draft['ItemsJson'] || '[]'); } catch (e) { items = []; }
            items.forEach(item => {
                const hasSku = !!item.sku;
                const key = hasSku ? ('sku:' + item.sku) : ('name:' + String(item.name || '').toLowerCase());
                if (!map[key]) {
                    map[key] = { sku: hasSku ? item.sku : '', name: item.name || 'Item', qty: 0 };
                }
                map[key].qty += (Number(item.qty) || 0);
            });
        });

        return Object.values(map).map(r => {
            const invRow = r.sku ? rawInventory.find(inv => String(inv['SKU'] || '').trim() === r.sku) : null;
            const inStock = invRow ? (Number(invRow['Stock']) || 0) : null; // null = not tracked in Inventory
            const toPurchase = inStock !== null ? Math.max(0, r.qty - inStock) : r.qty;
            return { sku: r.sku, name: r.name, needed: r.qty, inStock: inStock, toPurchase: toPurchase };
        }).sort((a, b) => b.toPurchase - a.toPurchase);
    }

    function shoppingListTableHTML(rows) {
        if (!rows.length) {
            return '<p style="color:var(--text-muted); font-size:0.85rem; padding:16px 0;">No pending orders yet — nothing to purchase.</p>';
        }
        return rows.map(r => {
            const covered = r.toPurchase <= 0;
            return `
            <div class="shopping-list-card" style="${covered ? 'opacity:0.6;' : ''}">
                <div class="shopping-list-card-top">
                    <div>
                        <div class="shopping-list-card-name">${r.name}</div>
                        ${r.sku ? `<div class="shopping-list-card-sku">${r.sku}</div>` : ''}
                    </div>
                    <div class="shopping-list-card-purchase" style="color:${covered ? '#10b981' : '#ef4444'};">
                        ${covered ? '✔ In stock' : r.toPurchase}
                    </div>
                </div>
                <div class="shopping-list-card-meta">
                    Needed: <strong>${r.needed}</strong> &nbsp;•&nbsp; In Inventory: <strong>${r.inStock !== null ? r.inStock : 'not tracked'}</strong>
                </div>
            </div>`;
        }).join('');
    }

    function openShoppingListModal() {
        const body = document.getElementById('shoppingListModalBody');
        body.innerHTML = shoppingListTableHTML(computePendingOrdersRequirement());
        document.getElementById('shoppingListModal').classList.add('active');
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
            if (err && err.name === 'AbortError') return; // cancelled the native share sheet
            alert('⚠️ Failed to prepare the bill for sharing: ' + (err.message || err));
        } finally {
            if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalLabel; }
        }
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
        startFreshNewOrder,
        updateDraftOrderStatus,
        editPendingOrder,
        deletePendingOrder,
        openShoppingListModal,
        saveOrderFormEdit,
        saveNewOrderEdit,
        openAssignAgentModal,
        confirmAssignAgent,
        toggleOrderItems,
        closeModal,
        viewOrderBill,
        shareBillOnWhatsApp
    });

    // The shell calls GK_viewInit itself right after this script loads —
    // don't also call fetchLiveData() here, or every navigation double-fetches.
    window.GK_viewInit = () => fetchLiveData(false);
    window.GK_viewRefresh = () => fetchLiveData(true);
})();
