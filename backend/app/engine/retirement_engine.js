var RetirementEngine = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/lib/recurring-totals.ts
	var PER_YEAR = {
		weekly: 52,
		biweekly: 26,
		monthly: 12,
		quarterly: 4,
		semiannual: 2,
		yearly: 1
	};
	/** The amount in the display currency, or null when it can't be known. */
	function inDisplayCurrency(rt, displayCurrency) {
		if (rt.currency === displayCurrency) return Number(rt.amount);
		if (rt.amount_primary != null) return Number(rt.amount_primary);
		return null;
	}
	//#endregion
	//#region src/lib/retirement.ts
	/** An item's amount normalised to a month, or null if it cannot be known. */
	function monthlyEquivalent(rt, displayCurrency) {
		const amount = inDisplayCurrency(rt, displayCurrency);
		const perYear = PER_YEAR[rt.frequency];
		if (amount == null || perYear == null) return null;
		return amount * perYear / 12;
	}
	/** The asset's value in the display currency, or null if unknown. */
	function assetValue(asset, displayCurrency) {
		if (asset.current_value_primary != null) return asset.current_value_primary;
		if (asset.current_value != null && asset.currency === displayCurrency) return asset.current_value;
		return null;
	}
	/** Display-currency per asset-currency unit, from the asset's own value pair. */
	function conversionRate(asset, displayCurrency) {
		if (asset.currency === displayCurrency) return 1;
		if (asset.current_value && asset.current_value_primary != null) return asset.current_value_primary / asset.current_value;
		return null;
	}
	/** What the asset cost, in the display currency, or null when it is not known. */
	function assetCostBasis(asset, displayCurrency) {
		if (asset.purchase_price == null) return null;
		const rate = conversionRate(asset, displayCurrency);
		return rate == null ? null : asset.purchase_price * rate;
	}
	/** The asset's own growth rule as a rate per year, or null when it has none. */
	function annualGrowthPercent(asset, value) {
		if (!asset.growth_type || asset.growth_rate == null || !asset.growth_frequency) return null;
		const perYear = {
			daily: 365,
			weekly: 52,
			monthly: 12,
			yearly: 1
		}[asset.growth_frequency];
		if (perYear == null) return null;
		if (asset.growth_type === "percentage") return ((1 + asset.growth_rate / 100) ** perYear - 1) * 100;
		return value ? asset.growth_rate * perYear / value * 100 : null;
	}
	/** A fixed asset income (a rental) as a monthly amount in the display currency. */
	function assetFixedMonthly(asset, displayCurrency) {
		if (asset.income_mode !== "fixed" || asset.income_amount == null || !asset.income_frequency) return null;
		const rate = conversionRate(asset, displayCurrency);
		const perYear = PER_YEAR[asset.income_frequency];
		if (rate == null || perYear == null) return null;
		return asset.income_amount * rate * perYear / 12;
	}
	function assetIncomeLines(asset, displayCurrency) {
		const lines = [];
		let skipped = 0;
		const value = assetValue(asset, displayCurrency);
		if (asset.income_mode === "yield" && asset.income_rate != null) {
			if (value == null) skipped += 1;
			else lines.push({
				id: `asset:${asset.id}:income`,
				kind: "asset-income",
				label: asset.name,
				monthly: value * asset.income_rate / 100 / 12,
				asset
			});
		} else if (asset.income_mode === "fixed" && asset.income_amount != null && asset.income_frequency) {
			const rate = conversionRate(asset, displayCurrency);
			const perYear = PER_YEAR[asset.income_frequency];
			if (rate == null || perYear == null) skipped += 1;
			else lines.push({
				id: `asset:${asset.id}:income`,
				kind: "asset-income",
				label: asset.name,
				monthly: asset.income_amount * rate * perYear / 12,
				frequency: asset.income_frequency,
				asset
			});
		}
		if (asset.sell_percent_per_year) {
			if (value == null) skipped += 1;
			else lines.push({
				id: `asset:${asset.id}:sale`,
				kind: "asset-sale",
				label: asset.name,
				monthly: value * asset.sell_percent_per_year / 100 / 12,
				asset
			});
		}
		return {
			lines,
			skipped
		};
	}
	/**
	* Passive income against outgoings. Income is every active recurring credit,
	* plus the modelled income and planned sales of every live asset, grouped or
	* not. Outgoings are every active recurring debit. Any line can be left out of
	* the totals by id (income line ids, or the recurring item's id).
	*/
	function computeRetirement(items, assets, displayCurrency, excludedIds) {
		const income = [];
		const outgoing = [];
		let skipped = 0;
		for (const item of items) {
			if (!item.is_active) continue;
			const monthly = monthlyEquivalent(item, displayCurrency);
			if (monthly == null) {
				skipped += 1;
				continue;
			}
			if (item.type === "credit") income.push({
				id: item.id,
				kind: "recurring",
				label: item.description,
				monthly,
				frequency: item.frequency
			});
			else outgoing.push({
				item,
				monthly
			});
		}
		for (const asset of assets) {
			if (asset.is_archived || asset.sell_date) continue;
			const result = assetIncomeLines(asset, displayCurrency);
			income.push(...result.lines);
			skipped += result.skipped;
		}
		income.sort((a, b) => b.monthly - a.monthly);
		outgoing.sort((a, b) => b.monthly - a.monthly);
		const incomeMonthly = income.filter((l) => !excludedIds.has(l.id)).reduce((sum, l) => sum + l.monthly, 0);
		const outgoingMonthly = outgoing.filter((l) => !excludedIds.has(l.item.id)).reduce((sum, l) => sum + l.monthly, 0);
		return {
			income,
			outgoing,
			incomeMonthly,
			outgoingMonthly,
			coverage: outgoingMonthly > 0 ? incomeMonthly / outgoingMonthly : null,
			surplusMonthly: incomeMonthly - outgoingMonthly,
			skipped
		};
	}
	//#endregion
	//#region src/lib/retirement-projection.ts
	var CASH_ID = "__cash__";
	function active(item, year) {
		return year >= item.fromYear && (item.toYear === void 0 || year <= item.toYear);
	}
	function projectRetirement(input) {
		const { assumptions: a } = input;
		const inflation = a.inflationPercent / 100;
		const startYear = a.drawdownStartYear ?? 0;
		const ordered = a.sellStrategy === "ordered";
		const incomeTaxDefault = (a.taxIncomePercent ?? 0) / 100;
		const bufferYears = a.bufferYears ?? 0;
		const priceLevel = [1];
		for (let y = 0; y < a.horizonYears; y++) priceLevel.push(priceLevel[y] * (1 + (input.market ? (input.market.inflationPercent[y] ?? a.inflationPercent) / 100 : inflation)));
		const state = input.assets.map((asset) => ({
			...asset,
			held: (asset.startYear ?? 0) <= 0,
			basis: asset.costBasis ?? Math.max(0, asset.value)
		}));
		state.push({
			id: CASH_ID,
			name: "cash",
			value: 0,
			drawable: true,
			held: true,
			sellOrder: -1,
			basis: 0
		});
		const liabilities = state.filter((s) => s.value < 0).reduce((sum, s) => sum + s.value, 0);
		const holdings = state.filter((s) => s.value >= 0);
		const cash = holdings.find((h) => h.id === CASH_ID);
		const drawableTotal = () => holdings.filter((h) => h.held && h.drawable).reduce((sum, h) => sum + h.value, 0);
		const ownedTotal = () => holdings.filter((h) => h.held).reduce((sum, h) => sum + h.value, 0);
		/** Share of a sale that is gain, for the tax. */
		const gainsRate = (h) => h.taxFree ? 0 : (h.gainsTaxPercent ?? a.taxGainsPercent ?? 0) / 100;
		const gainShare = (h) => h.taxFree || h.value <= 0 ? 0 : Math.max(0, 1 - h.basis / h.value);
		const keepAfterTax = (h) => 1 - gainShare(h) * gainsRate(h);
		/** Take `gross` out of an asset, shrinking its cost basis in proportion; returns the tax on the gain. */
		function take(h, gross) {
			const tax = gross * gainShare(h) * gainsRate(h);
			h.basis -= h.value > 0 ? h.basis * gross / h.value : 0;
			h.value -= gross;
			return tax;
		}
		/**
		* Sell from `pool` until `net` has arrived after tax on the gains (or the
		* pool is empty). Returns what arrived, the tax withheld and what was sold.
		*/
		function sell(pool, net) {
			const sold = {};
			let arrived = 0;
			let tax = 0;
			const live = pool.filter((h) => h.value > 0);
			if (net <= 0 || live.length === 0) return {
				net: 0,
				tax: 0,
				sold
			};
			if (ordered) {
				const queue = [...live].sort((x, y) => (x.sellOrder ?? Number.MAX_SAFE_INTEGER) - (y.sellOrder ?? Number.MAX_SAFE_INTEGER));
				for (const h of queue) {
					const remaining = net - arrived;
					if (remaining <= 1e-9) break;
					const factor = keepAfterTax(h);
					const gross = Math.min(h.value, remaining / factor);
					const paid = take(h, gross);
					sold[h.id] = (sold[h.id] ?? 0) + gross;
					tax += paid;
					arrived += gross - paid;
				}
			} else {
				const total = live.reduce((sum, h) => sum + h.value, 0);
				const weightedKeep = live.reduce((sum, h) => sum + h.value / total * keepAfterTax(h), 0);
				const gross = Math.min(total, net / weightedKeep);
				for (const h of live) {
					const part = h.value / total * gross;
					const paid = take(h, part);
					sold[h.id] = (sold[h.id] ?? 0) + part;
					tax += paid;
					arrived += part - paid;
				}
			}
			return {
				net: arrived,
				tax,
				sold
			};
		}
		const drawableNow = drawableTotal();
		const netWorthNow = ownedTotal() + liabilities;
		const rows = [];
		let runwayYears = null;
		let totalTax = 0;
		const lines = [...input.timed ?? [], ...input.whatIfs];
		for (let year = 0; year < a.horizonYears; year++) {
			const inflate = priceLevel[year];
			const incomeInflate = a.incomeIndexed ? inflate : 1;
			for (const h of holdings) if (!h.held && h.startYear === year) h.held = true;
			let income = input.recurringIncomeMonthly * 12 * incomeInflate + (input.recurringIncomeFlatMonthly ?? 0) * 12;
			let incomeTaxDue = income * incomeTaxDefault;
			let outgoingMonthly = input.outgoingMonthly;
			let outgoingFlatMonthly = input.outgoingFlatMonthly ?? 0;
			let spending = false;
			for (const w of input.whatIfs) if (w.kind === "spend" && year >= w.fromYear) {
				outgoingMonthly = w.inflates === false ? 0 : w.monthly;
				outgoingFlatMonthly = w.inflates === false ? w.monthly : 0;
				spending = true;
			}
			let outgoing = outgoingMonthly * 12 * inflate + outgoingFlatMonthly * 12;
			let oneOffs = 0;
			let assetIncome = 0;
			let saleIncome = 0;
			let gainsDue = 0;
			let withheldTax = 0;
			for (const w of lines) {
				if (w.kind === "income" && active(w, year)) {
					const amount = w.monthly * 12 * (w.inflates === false ? 1 : incomeInflate);
					income += amount;
					incomeTaxDue += amount * (w.taxPercent !== void 0 ? w.taxPercent / 100 : incomeTaxDefault);
				}
				if (w.kind === "expense" && active(w, year)) {
					if (spending && input.timed?.includes(w)) continue;
					outgoing += w.monthly * 12 * (w.inflates === false ? 1 : inflate);
				}
			}
			for (const w of input.whatIfs) {
				if (w.kind === "oneoff" && w.year === year) oneOffs += w.amount;
				if (w.kind === "sell" && w.year === year) {
					const asset = holdings.find((h) => h.id === w.assetId && h.held);
					if (asset) {
						const proceeds = asset.value * (1 - w.feesPercent / 100);
						oneOffs += proceeds;
						gainsDue += Math.max(0, proceeds - asset.basis) * gainsRate(asset);
						asset.value = 0;
						asset.basis = 0;
						asset.held = false;
					}
				}
			}
			let yieldIncome = 0;
			let rentIncome = 0;
			let yieldTaxDue = 0;
			let rentTaxDue = 0;
			for (const h of holdings) {
				if (!h.held || h.value <= 0) continue;
				if (h.yieldPercent) {
					const paid = h.value * h.yieldPercent / 100;
					yieldIncome += paid;
					yieldTaxDue += paid * (h.yieldTaxPercent ?? a.taxAssetIncomePercent ?? 0) / 100;
				}
				if (h.fixedMonthly && (h.fixedUntilYear === void 0 || year <= h.fixedUntilYear)) {
					const rent = h.fixedMonthly * 12 * (h.fixedFlat ? 1 : incomeInflate);
					rentIncome += rent;
					rentTaxDue += rent * (h.rentTaxPercent ?? a.taxRentPercent ?? 0) / 100;
				}
				if (h.sellPercent && h.drawable) {
					const sold = Math.min(h.value, h.value * h.sellPercent / 100);
					gainsDue += sold * gainShare(h) * gainsRate(h);
					take(h, sold);
					saleIncome += sold;
				}
			}
			assetIncome = yieldIncome + rentIncome;
			income += assetIncome + saleIncome;
			const payableTax = incomeTaxDue + yieldTaxDue + rentTaxDue + gainsDue;
			const netFlow = income + oneOffs - outgoing - payableTax;
			const phase = year < startYear ? "saving" : a.drawdownEndYear !== void 0 && year > a.drawdownEndYear ? "after" : "drawdown";
			let unfunded = 0;
			const drawn = {};
			const addDrawn = (sold) => {
				for (const [id, amount] of Object.entries(sold)) drawn[id] = (drawn[id] ?? 0) + amount;
			};
			const heldDrawable = () => holdings.filter((h) => h.held && h.drawable);
			const others = () => heldDrawable().filter((h) => h.id !== CASH_ID);
			const bufferTarget = bufferYears > 0 && year >= startYear ? bufferYears * outgoing : 0;
			if (bufferTarget > 0 && year === startYear) {
				const result = sell(others(), bufferTarget - cash.value);
				cash.value += result.net;
				withheldTax += result.tax;
				addDrawn(result.sold);
			}
			if (netFlow < 0 && year >= startYear) {
				const need = -netFlow;
				let remaining = need;
				if (bufferYears > 0) {
					const fromCash = Math.min(cash.value, remaining);
					cash.value -= fromCash;
					remaining -= fromCash;
					if (fromCash > 0) drawn[CASH_ID] = (drawn["__cash__"] ?? 0) + fromCash;
				}
				if (remaining > 1e-9) {
					const result = sell(bufferYears > 0 ? others() : heldDrawable(), remaining);
					withheldTax += result.tax;
					addDrawn(result.sold);
					remaining -= result.net;
				}
				unfunded = Math.max(0, remaining);
				if (unfunded > 1e-6 && runwayYears === null) runwayYears = year + (need > 0 ? (need - unfunded) / need : 0);
			} else if (netFlow > 0) {
				const pool = heldDrawable();
				let surplus = netFlow;
				if (bufferTarget > 0 && cash.value < bufferTarget) {
					const fill = Math.min(surplus, bufferTarget - cash.value);
					cash.value += fill;
					cash.basis += fill;
					surplus -= fill;
				}
				if (surplus > 0) {
					const target = pool.some((h) => h.value > 0) ? pool.filter((h) => h.value > 0) : [cash];
					const base = target.reduce((sum, h) => sum + h.value, 0);
					for (const h of target) {
						const add = base > 0 ? h.value / base * surplus : surplus;
						h.value += add;
						h.basis += add;
					}
				}
			}
			let before = 0;
			let after = 0;
			for (const h of holdings) {
				if (!h.held) continue;
				const rate = input.market?.growthPercent(h, year) ?? h.growthPercent ?? 0;
				if (h.drawable && h.id !== "__cash__") before += h.value;
				h.value *= 1 + rate / 100;
				if (h.drawable && h.id !== "__cash__") after += h.value;
			}
			if (bufferYears > 0 && year >= startYear && after >= before) {
				const nextTarget = bufferYears * outgoing * (priceLevel[year + 1] / priceLevel[year]);
				if (cash.value < nextTarget) {
					const result = sell(others(), nextTarget - cash.value);
					cash.value += result.net;
					withheldTax += result.tax;
					addDrawn(result.sold);
				}
			}
			const byAsset = {};
			for (const h of holdings) if (h.held && h.value > .005) byAsset[h.id] = h.value;
			const yearTax = payableTax + withheldTax;
			const taxKinds = {
				income: incomeTaxDue,
				yield: yieldTaxDue,
				rent: rentTaxDue,
				gains: gainsDue + withheldTax
			};
			totalTax += yearTax;
			rows.push({
				year,
				phase,
				byAsset,
				drawn,
				assetIncome,
				saleIncome,
				drawable: drawableTotal(),
				netWorth: ownedTotal() + liabilities,
				income: income + Math.max(0, oneOffs),
				outgoing: outgoing + Math.max(0, -oneOffs),
				netFlow,
				unfunded,
				tax: yearTax,
				taxKinds,
				deflator: priceLevel[year + 1]
			});
		}
		const endRow = a.drawdownEndYear !== void 0 ? rows[a.drawdownEndYear] : void 0;
		return {
			rows,
			runwayYears,
			leftAtEnd: endRow ? endRow.drawable : null,
			drawableNow,
			netWorthNow,
			totalTax
		};
	}
	/** The assets you would normally sell from: not property or vehicles, not liabilities. */
	function defaultDrawable(type, value) {
		return value > 0 && type !== "real_estate" && type !== "vehicle";
	}
	//#endregion
	//#region src/lib/retirement-model.ts
	var DEFAULT_PLAN = {
		flat: [],
		assumptions: {
			horizonYears: 30,
			inflationPercent: 2,
			incomeIndexed: true,
			drawdownStartYear: 0,
			sellStrategy: "pro_rata"
		},
		drawable: {},
		growth: {},
		sellOrder: {},
		tempAssets: [],
		whatIfs: [],
		lineEnd: {},
		taxFree: {},
		taxRates: {}
	};
	/** What the retirement page counts, turned into the projection's input, for the saved plan. */
	function buildProjectionInputs(plan, items, assets, currency, excluded, thisYear = (/* @__PURE__ */ new Date()).getFullYear()) {
		const summary = computeRetirement(items, assets, currency, excluded);
		const flatSet = new Set(plan.flat ?? []);
		const sum = (lines) => lines.reduce((total, l) => total + l.monthly, 0);
		const lineEnd = plan.lineEnd ?? {};
		const ends = (id) => lineEnd[id] !== void 0;
		const recurringIncome = summary.income.filter((l) => l.kind === "recurring" && !excluded.has(l.id));
		const countedOutgoing = summary.outgoing.filter((l) => !excluded.has(l.item.id));
		const open = (list, idOf) => list.filter((l) => !ends(idOf(l)));
		const rates = plan.taxRates ?? {};
		const solo = (id) => ends(id) || rates[`income:${id}`] !== void 0;
		const plainIncome = recurringIncome.filter((l) => !solo(l.id));
		const recurringIncomeMonthly = sum(plainIncome.filter((l) => !flatSet.has(l.id)));
		const recurringIncomeFlatMonthly = sum(plainIncome.filter((l) => flatSet.has(l.id)));
		const living = plan.living && plan.living.monthly > 0 ? plan.living : null;
		const outgoingMonthly = sum(open(countedOutgoing, (l) => l.item.id).filter((l) => !flatSet.has(l.item.id))) + (living && living.inflates ? living.monthly : 0);
		const outgoingFlatMonthly = sum(open(countedOutgoing, (l) => l.item.id).filter((l) => flatSet.has(l.item.id))) + (living && !living.inflates ? living.monthly : 0);
		const timed = [...recurringIncome.filter((l) => solo(l.id)).map((l) => ({
			id: l.id,
			kind: "income",
			label: l.label,
			monthly: l.monthly,
			fromYear: 0,
			toYear: ends(l.id) ? lineEnd[l.id] - thisYear : void 0,
			inflates: !flatSet.has(l.id),
			taxPercent: rates[`income:${l.id}`]
		})), ...countedOutgoing.filter((l) => ends(l.item.id)).map((l) => ({
			id: l.item.id,
			kind: "expense",
			label: l.item.description,
			monthly: l.monthly,
			fromYear: 0,
			toYear: lineEnd[l.item.id] - thisYear,
			inflates: !flatSet.has(l.item.id)
		}))];
		const projectionAssets = (() => {
			const list = [];
			for (const asset of assets) {
				if (asset.is_archived || asset.sell_date) continue;
				const value = assetValue(asset, currency);
				if (value == null) continue;
				const yielding = asset.income_mode === "yield" && asset.income_rate != null && !excluded.has(`asset:${asset.id}:income`);
				const rental = !excluded.has(`asset:${asset.id}:income`) ? assetFixedMonthly(asset, currency) : null;
				list.push({
					id: asset.id,
					name: asset.name,
					value,
					drawable: plan.drawable[asset.id] ?? defaultDrawable(asset.type, value),
					growthPercent: plan.growth[asset.id] ?? annualGrowthPercent(asset, value) ?? 0,
					sellOrder: plan.sellOrder[asset.id],
					yieldPercent: yielding ? asset.income_rate ?? void 0 : void 0,
					fixedMonthly: rental ?? void 0,
					fixedFlat: flatSet.has(`asset:${asset.id}:income`) || void 0,
					fixedUntilYear: ends(`asset:${asset.id}:income`) ? lineEnd[`asset:${asset.id}:income`] - thisYear : void 0,
					costBasis: assetCostBasis(asset, currency) ?? void 0,
					yieldTaxPercent: rates[`yield:${asset.id}`],
					rentTaxPercent: rates[`rent:${asset.id}`],
					gainsTaxPercent: rates[`gains:${asset.id}`],
					taxFree: plan.taxFree?.[asset.id] || void 0,
					sellPercent: asset.sell_percent_per_year && !excluded.has(`asset:${asset.id}:sale`) ? asset.sell_percent_per_year : void 0
				});
			}
			for (const temp of plan.tempAssets ?? []) list.push({
				id: temp.id,
				name: temp.name,
				value: temp.value,
				drawable: plan.drawable[temp.id] ?? true,
				growthPercent: plan.growth[temp.id] ?? temp.growthPercent,
				yieldPercent: temp.yieldPercent || void 0,
				sellOrder: plan.sellOrder[temp.id],
				temporary: true,
				startYear: temp.fromYear || void 0,
				riskClass: temp.riskClass,
				taxFree: plan.taxFree?.[temp.id] || void 0,
				yieldTaxPercent: rates[`yield:${temp.id}`],
				gainsTaxPercent: rates[`gains:${temp.id}`]
			});
			return list;
		})();
		return {
			summary,
			flatSet,
			projectionAssets,
			base: {
				recurringIncomeMonthly,
				recurringIncomeFlatMonthly,
				outgoingMonthly,
				outgoingFlatMonthly,
				assets: projectionAssets,
				assumptions: plan.assumptions,
				timed
			},
			whatIfs: plan.whatIfs.map((w) => w.kind === "income" && rates[`whatif:${w.id}`] !== void 0 ? {
				...w,
				taxPercent: rates[`whatif:${w.id}`]
			} : w)
		};
	}
	//#endregion
	//#region src/lib/retirement-simulation.ts
	/**
	* A Monte Carlo run of the retirement projection.
	*
	* The plan's own growth rate for each asset is its long-run average yearly
	* growth, crashes included (a historical figure already contains them), unless
	* that is switched off. Each simulated future then draws, year by year, a random return around it (most
	* of it shared across assets, like a real market), an occasional crash that
	* hits risky assets hard and safer ones less, a slump of weaker growth after a
	* crash, and an inflation path that wanders and can spike. Every future is
	* run through the same engine as the plan, so incomes, costs, what-ifs and the
	* order of selling all apply. The result is how often the assets last, not a
	* forecast.
	*/
	var RISK_CLASSES = [
		"stocks",
		"bonds",
		"property",
		"cash",
		"fixed"
	];
	/** How each class behaves: ordinary yearly swings and how much of a crash it takes. */
	var CLASS_TRAITS = {
		stocks: {
			volatility: 16,
			crashShare: 1
		},
		bonds: {
			volatility: 6,
			crashShare: .25
		},
		property: {
			volatility: 9,
			crashShare: .4
		},
		cash: {
			volatility: 1,
			crashShare: 0
		},
		fixed: {
			volatility: 0,
			crashShare: 0
		}
	};
	var DEFAULT_SIM = {
		runs: 1e3,
		seed: 1,
		volatilityScale: 1,
		crashChancePercent: 8,
		crashMinPercent: 30,
		crashMaxPercent: 40,
		slumpYears: 2,
		slumpCutPercent: 50,
		inflationSpread: 1.5,
		spikeChancePercent: 3,
		spikeExtraPoints: 5,
		rateIncludesCrashes: true,
		todaysMoney: true,
		classes: {}
	};
	/** What an asset is treated as unless you say otherwise. */
	function defaultRiskClass(type) {
		if (type === "investment") return "stocks";
		if (type === "real_estate") return "property";
		if (type === "cash" || type === "bank_account") return "cash";
		return "fixed";
	}
	/** A small seedable generator, so the same inputs give the same answer. */
	function makeRng(seed) {
		let state = seed >>> 0;
		return () => {
			state = state + 1831565813 >>> 0;
			let t = state;
			t = Math.imul(t ^ t >>> 15, t | 1);
			t ^= t + Math.imul(t ^ t >>> 7, t | 61);
			return ((t ^ t >>> 14) >>> 0) / 4294967296;
		};
	}
	function normal(rng) {
		const u = Math.max(rng(), 1e-12);
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
	}
	/** Share of an asset's yearly swing that moves with the market as a whole. */
	var MARKET_WEIGHT = .7;
	var calibrationCache = /* @__PURE__ */ new Map();
	/**
	* The ordinary-year return that makes the long-run compound growth of an asset,
	* with this crash and swing model, equal `expected`. It is solved once on a long
	* fixed run of random years (so it does not vary between calls), then reused.
	*/
	function calibratedMean(cls, expected, params) {
		if (cls === "fixed") return expected;
		const key = [
			cls,
			expected,
			params.volatilityScale,
			params.crashChancePercent,
			params.crashMinPercent,
			params.crashMaxPercent,
			params.slumpYears,
			params.slumpCutPercent
		].join("|");
		const hit = calibrationCache.get(key);
		if (hit !== void 0) return hit;
		const traits = CLASS_TRAITS[cls];
		const sigma = traits.volatility * params.volatilityScale;
		const n = 2e4;
		const rng = makeRng(987654321);
		const z = new Float64Array(n);
		const crash = new Float64Array(n);
		const slump = new Uint8Array(n);
		let slumpLeft = 0;
		const span = Math.max(0, params.crashMaxPercent - params.crashMinPercent);
		for (let i = 0; i < n; i++) {
			z[i] = normal(rng);
			const crashed = rng() < params.crashChancePercent / 100;
			crash[i] = crashed ? params.crashMinPercent + rng() * span : -1;
			slump[i] = slumpLeft > 0 ? 1 : 0;
			if (slumpLeft > 0) slumpLeft -= 1;
			if (crashed) slumpLeft = params.slumpYears;
		}
		const cut = 1 - params.slumpCutPercent / 100;
		const growth = (mean) => {
			let total = 0;
			for (let i = 0; i < n; i++) {
				const rate = crash[i] >= 0 && traits.crashShare > 0 ? -crash[i] * traits.crashShare : (slump[i] ? mean * cut : mean) + sigma * z[i];
				total += Math.log(1 + Math.max(-95, rate) / 100);
			}
			return total / n;
		};
		const target = Math.log(1 + expected / 100);
		let low = -60;
		let high = 120;
		for (let step = 0; step < 40; step++) {
			const mid = (low + high) / 2;
			if (growth(mid) < target) low = mid;
			else high = mid;
		}
		const solved = (low + high) / 2;
		if (calibrationCache.size > 500) calibrationCache.clear();
		calibrationCache.set(key, solved);
		return solved;
	}
	/** Draw one possible future. */
	function drawMarket(rng, params, years, baseInflationPercent, classOf) {
		const inflation = [];
		let drift = 0;
		let spellLeft = 0;
		const marketShock = [];
		const crashDepth = [];
		const slump = [];
		let slumpLeft = 0;
		for (let y = 0; y < years; y++) {
			drift = .6 * drift + params.inflationSpread * Math.sqrt(.64) * normal(rng);
			if (spellLeft === 0 && rng() < params.spikeChancePercent / 100) spellLeft = 3;
			const extra = spellLeft > 0 ? params.spikeExtraPoints : 0;
			if (spellLeft > 0) spellLeft -= 1;
			inflation.push(Math.max(-2, baseInflationPercent + drift + extra));
			marketShock.push(normal(rng));
			const crashed = rng() < params.crashChancePercent / 100;
			const span = Math.max(0, params.crashMaxPercent - params.crashMinPercent);
			crashDepth.push(crashed ? params.crashMinPercent + rng() * span : null);
			slump.push(slumpLeft > 0);
			if (slumpLeft > 0) slumpLeft -= 1;
			if (crashed) slumpLeft = params.slumpYears;
		}
		const own = /* @__PURE__ */ new Map();
		const noise = (id) => {
			let list = own.get(id);
			if (!list) {
				list = Array.from({ length: years }, () => normal(rng));
				own.set(id, list);
			}
			return list;
		};
		return {
			inflationPercent: inflation,
			growthPercent: (asset, year) => {
				const cls = classOf(asset);
				const traits = CLASS_TRAITS[cls];
				if (cls === "fixed") return void 0;
				const expected = asset.growthPercent ?? 0;
				const anchored = params.rateIncludesCrashes ? calibratedMean(cls, expected, params) : expected;
				const ordinary = (slump[year] ? anchored * (1 - params.slumpCutPercent / 100) : anchored) + traits.volatility * params.volatilityScale * (MARKET_WEIGHT * marketShock[year] + Math.sqrt(1 - MARKET_WEIGHT ** 2) * noise(asset.id)[year]);
				const crash = crashDepth[year];
				const value = crash !== null && traits.crashShare > 0 ? -crash * traits.crashShare : ordinary;
				return Math.max(-95, value);
			}
		};
	}
	function percentile(sorted, p) {
		if (sorted.length === 0) return 0;
		return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))];
	}
	/** How the stress test treats an asset: what you set for it, else its own class (temporary assets), else its type. */
	function riskClassOf(asset, params, types) {
		const own = asset.riskClass;
		return params.classes[asset.id] ?? (own && RISK_CLASSES.includes(own) ? own : defaultRiskClass(types[asset.id] ?? ""));
	}
	function classifier(params, types) {
		return (asset) => riskClassOf(asset, params, types);
	}
	/** Run many futures through the projection. `types` maps asset id to its type, for default risk classes. */
	function simulate(input, params, types = {}) {
		const years = input.assumptions.horizonYears;
		const rng = makeRng(params.seed);
		const classOf = classifier(params, types);
		const nominalYears = Array.from({ length: years }, () => []);
		const realYears = Array.from({ length: years }, () => []);
		const depletedAt = [];
		let lasted = 0;
		for (let run = 0; run < params.runs; run++) {
			const market = drawMarket(rng, params, years, input.assumptions.inflationPercent, classOf);
			const projection = projectRetirement({
				...input,
				market
			});
			if (projection.runwayYears === null) lasted += 1;
			else depletedAt.push(Math.floor(projection.runwayYears));
			projection.rows.forEach((row, i) => {
				nominalYears[i].push(row.drawable);
				realYears[i].push(row.drawable / row.deflator);
			});
		}
		const summarise = (perYear) => {
			const bands = perYear.map((values, year) => {
				const sorted = [...values].sort((a, b) => a - b);
				return {
					year,
					p10: percentile(sorted, 10),
					p25: percentile(sorted, 25),
					p50: percentile(sorted, 50),
					p75: percentile(sorted, 75),
					p90: percentile(sorted, 90)
				};
			});
			const ends = [...perYear[years - 1] ?? []].sort((a, b) => a - b);
			return {
				bands,
				worstCaseEnd: percentile(ends, 5),
				medianEnd: percentile(ends, 50)
			};
		};
		const depletedBy = Array.from({ length: years }, (_, year) => depletedAt.filter((d) => d <= year).length / params.runs);
		const sortedDepleted = [...depletedAt].sort((a, b) => a - b);
		return {
			runs: params.runs,
			successRate: lasted / params.runs,
			nominal: summarise(nominalYears),
			real: summarise(realYears),
			depletedBy,
			medianRunOutYear: sortedDepleted.length ? percentile(sortedDepleted, 50) : null
		};
	}
	/** The input with every planned monthly cost scaled, to ask "what if I spent more or less". */
	function scaleSpending(input, factor) {
		return {
			...input,
			outgoingMonthly: input.outgoingMonthly * factor,
			outgoingFlatMonthly: (input.outgoingFlatMonthly ?? 0) * factor,
			whatIfs: input.whatIfs.map((w) => w.kind === "expense" || w.kind === "spend" ? {
				...w,
				monthly: w.monthly * factor
			} : w)
		};
	}
	var SWEEP_SPEND = [
		.8,
		.9,
		1,
		1.1,
		1.25,
		1.5
	];
	var SWEEP_CRASH = [
		0,
		5,
		10,
		15,
		25
	];
	function sweepCell(input, params, types, runs, spend, crash) {
		return {
			spend,
			crash,
			successRate: simulate(scaleSpending(input, spend), {
				...params,
				runs,
				crashChancePercent: crash
			}, types).successRate
		};
	}
	/** The same grid, all at once; for callers that have no screen to keep responsive. */
	function sweepSync(input, params, types, runsPerCell) {
		return SWEEP_CRASH.flatMap((crash) => SWEEP_SPEND.map((spend) => sweepCell(input, params, types, runsPerCell, spend, crash)));
	}
	var BUFFER_YEARS = [
		0,
		1,
		2,
		3,
		5
	];
	function bufferCell(input, params, types, runs, years) {
		const result = simulate({
			...input,
			assumptions: {
				...input.assumptions,
				bufferYears: years
			}
		}, {
			...params,
			runs
		}, types);
		return {
			years,
			successRate: result.successRate,
			medianEnd: result.real.medianEnd
		};
	}
	/** The same comparison, all at once. */
	function bufferSweepSync(input, params, types, runs) {
		return BUFFER_YEARS.map((years) => bufferCell(input, params, types, runs, years));
	}
	//#endregion
	//#region src/engine/server-entry.ts
	/**
	* The retirement engine as a function of one JSON request, bundled for the server (see
	* `npm run build:engine`) so the MCP tools run exactly the code the Retirement page runs. Nothing here
	* touches the browser; the server hands in the plan, the recurring items and the assets.
	*/
	var round = (v, digits = 0) => Number(v.toFixed(digits));
	function fullPlan(plan, overrides) {
		const base = {
			...DEFAULT_PLAN,
			...plan,
			assumptions: {
				...DEFAULT_PLAN.assumptions,
				...plan.assumptions ?? {}
			}
		};
		if (!overrides) return base;
		const a = { ...base.assumptions };
		if (overrides.horizonYears !== void 0) a.horizonYears = overrides.horizonYears;
		if (overrides.inflationPercent !== void 0) a.inflationPercent = overrides.inflationPercent;
		if (overrides.incomeIndexed !== void 0) a.incomeIndexed = overrides.incomeIndexed;
		if (overrides.drawdownStartYear !== void 0) a.drawdownStartYear = overrides.drawdownStartYear;
		if (overrides.drawdownEndYear !== void 0) a.drawdownEndYear = overrides.drawdownEndYear ?? void 0;
		if (overrides.sellStrategy !== void 0) a.sellStrategy = overrides.sellStrategy;
		if (overrides.taxIncomePercent !== void 0) a.taxIncomePercent = overrides.taxIncomePercent;
		if (overrides.taxYieldPercent !== void 0) a.taxAssetIncomePercent = overrides.taxYieldPercent;
		if (overrides.taxRentPercent !== void 0) a.taxRentPercent = overrides.taxRentPercent;
		if (overrides.taxGainsPercent !== void 0) a.taxGainsPercent = overrides.taxGainsPercent;
		if (overrides.bufferYears !== void 0) a.bufferYears = overrides.bufferYears;
		const out = {
			...base,
			assumptions: a
		};
		if (overrides.livingMonthly !== void 0 || overrides.livingInflates !== void 0) out.living = {
			monthly: overrides.livingMonthly ?? base.living?.monthly ?? 0,
			inflates: overrides.livingInflates ?? base.living?.inflates ?? true
		};
		if (overrides.addWhatIfs?.length) out.whatIfs = [...base.whatIfs, ...overrides.addWhatIfs.map((w, i) => ({
			...w,
			id: w.id ?? `extra-${i}`
		}))];
		return out;
	}
	function prepare(req, plan, overrides) {
		const full = fullPlan(plan, overrides);
		const built = buildProjectionInputs(full, req.items, req.assets, req.currency, new Set(req.excluded), req.thisYear);
		const input = {
			...built.base,
			whatIfs: built.whatIfs
		};
		const names = { [CASH_ID]: "cash buffer" };
		for (const a of built.projectionAssets) names[a.id] = a.name;
		return {
			full,
			input,
			built,
			names,
			types: Object.fromEntries(req.assets.map((a) => [a.id, a.type]))
		};
	}
	function byName(record, names) {
		return Object.fromEntries(Object.entries(record).filter(([, v]) => Math.abs(v) > .005).map(([id, v]) => [names[id] ?? id, round(v)]));
	}
	function projectionSummary(p, baseline, horizon) {
		const last = p.rows[horizon - 1];
		return {
			runwayYears: p.runwayYears === null ? `lasts all ${horizon} years` : round(p.runwayYears, 1),
			runwayYearsWithoutWhatIfs: baseline ? baseline.runwayYears === null ? `lasts all ${horizon} years` : round(baseline.runwayYears, 1) : void 0,
			assetsYouSellFromNow: round(p.drawableNow),
			netWorthNow: round(p.netWorthNow),
			assetsLeftAtHorizon: round(last?.drawable ?? 0),
			netWorthAtHorizon: round(last?.netWorth ?? 0),
			assetsLeftAtDrawdownEnd: p.leftAtEnd === null ? null : round(p.leftAtEnd),
			totalTax: round(p.totalTax),
			taxByKind: {
				income: round(p.rows.reduce((s, r) => s + r.taxKinds.income, 0)),
				yields: round(p.rows.reduce((s, r) => s + r.taxKinds.yield, 0)),
				rent: round(p.rows.reduce((s, r) => s + r.taxKinds.rent, 0)),
				gains: round(p.rows.reduce((s, r) => s + r.taxKinds.gains, 0))
			}
		};
	}
	function runProjection(req) {
		const { full, input, built, names } = prepare(req, req.plan, req.overrides);
		const scenario = projectRetirement(input);
		const baseline = full.whatIfs.length ? projectRetirement({
			...input,
			whatIfs: []
		}) : null;
		const horizon = full.assumptions.horizonYears;
		return {
			currency: req.currency,
			startYear: req.thisYear,
			settingsUsed: {
				assumptions: full.assumptions,
				livingAndTravel: full.living ?? null,
				whatIfs: full.whatIfs,
				temporaryAssets: full.tempAssets,
				linesWithALastYear: full.lineEnd ?? {}
			},
			summary: projectionSummary(scenario, baseline, horizon),
			assets: built.projectionAssets.map((a) => ({
				name: a.name,
				value: round(a.value),
				sellFrom: a.drawable,
				growthPercentPerYear: a.growthPercent ?? 0,
				yieldPercent: a.yieldPercent ?? null,
				fixedIncomeMonthly: a.fixedMonthly ?? null,
				costBasis: a.costBasis ?? null,
				sellOrder: a.sellOrder ?? null
			})),
			years: scenario.rows.map((r) => ({
				year: req.thisYear + r.year,
				phase: r.phase,
				income: round(r.income),
				outgoing: round(r.outgoing),
				tax: round(r.tax),
				netCashFlow: round(r.netFlow),
				soldFromAssets: byName(r.drawn, names),
				soldTotal: round(Object.values(r.drawn).reduce((s, v) => s + v, 0)),
				shortfallNotCovered: round(r.unfunded),
				assetsYouSellFromAtYearEnd: round(r.drawable),
				netWorthAtYearEnd: round(r.netWorth)
			}))
		};
	}
	function simParams(req, types) {
		return {
			...DEFAULT_SIM,
			runs: 1e3,
			...req.sim ?? {},
			classes: {
				...DEFAULT_SIM.classes,
				...req.sim?.classes ?? {}
			}
		};
	}
	function stressFor(req, plan, overrides, grid, buffers) {
		const { full, input, types } = prepare(req, plan, overrides);
		const params = simParams(req, types);
		params.runs = Math.min(5e3, Math.max(100, params.runs));
		const result = simulate(input, params, types);
		const view = params.todaysMoney ? result.real : result.nominal;
		const bands = (b) => b.bands.map((x) => ({
			year: req.thisYear + x.year,
			p10: round(x.p10),
			p25: round(x.p25),
			median: round(x.p50),
			p75: round(x.p75),
			p90: round(x.p90)
		}));
		const cells = Math.min(1e3, Math.max(100, req.runsPerCell ?? 300));
		return {
			futures: result.runs,
			chanceTheMoneyLasts: round(result.successRate, 3),
			medianRunOutYearIfItDoes: result.medianRunOutYear === null ? null : req.thisYear + result.medianRunOutYear,
			shownIn: params.todaysMoney ? "today's money" : "future money",
			typicalAssetsLeftAtEnd: round(view.medianEnd),
			badLuckAssetsLeftAtEnd_worst1in20: round(view.worstCaseEnd),
			assetsYouSellFromByYear: bands(view),
			shareOfFuturesRunOutByYear: result.depletedBy.map((s, i) => ({
				year: req.thisYear + i,
				share: round(s, 3)
			})),
			settings: {
				crashChancePercentPerYear: params.crashChancePercent,
				crashDepthPercent: [params.crashMinPercent, params.crashMaxPercent],
				slumpYears: params.slumpYears,
				slumpGrowthLostPercent: params.slumpCutPercent,
				marketSwingsScale: params.volatilityScale,
				inflationWobblePoints: params.inflationSpread,
				inflationSpikeChancePercent: params.spikeChancePercent,
				growthRatesIncludeCrashes: params.rateIncludesCrashes,
				seed: params.seed
			},
			resilienceGrid: grid ? sweepSync(input, params, types, cells).map((c) => ({
				spendingPercentOfPlan: Math.round(c.spend * 100),
				crashChancePercentPerYear: c.crash,
				chanceTheMoneyLasts: round(c.successRate, 3)
			})) : void 0,
			cashBufferComparison: buffers ? bufferSweepSync(input, params, types, cells).map((c) => ({
				bufferYears: c.years,
				chanceTheMoneyLasts: round(c.successRate, 3),
				typicalAssetsLeftTodaysMoney: round(c.medianEnd)
			})) : void 0,
			horizonYears: full.assumptions.horizonYears
		};
	}
	function runCompare(req) {
		const all = {
			"Current plan": req.plan,
			...req.scenarios ?? {}
		};
		const rows = (req.names?.length ? ["Current plan", ...req.names.filter((n) => n !== "Current plan")] : Object.keys(all)).filter((name) => name in all).map((name) => {
			const { full, input } = prepare(req, all[name], name === "Current plan" ? req.overrides : void 0);
			const p = projectRetirement(input);
			const baseline = full.whatIfs.length ? projectRetirement({
				...input,
				whatIfs: []
			}) : null;
			return {
				scenario: name,
				livingAndTravelMonthly: full.living?.monthly ?? 0,
				drawdownStartsYear: req.thisYear + (full.assumptions.drawdownStartYear ?? 0),
				...projectionSummary(p, baseline, full.assumptions.horizonYears),
				stressTest: req.withStress ? stressFor(req, all[name], name === "Current plan" ? req.overrides : void 0, false, false).chanceTheMoneyLasts : void 0
			};
		});
		return {
			currency: req.currency,
			scenarios: rows,
			missing: (req.names ?? []).filter((n) => !(n in all))
		};
	}
	/** Entry point: a JSON request in, a JSON answer out. */
	function run(requestJson) {
		try {
			const req = JSON.parse(requestJson);
			const answer = req.op === "projection" ? runProjection(req) : req.op === "stress" ? stressFor(req, req.plan, req.overrides, !!req.includeGrid, !!req.includeBuffers) : runCompare(req);
			return JSON.stringify(answer);
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}
	//#endregion
	exports.run = run;
	return exports;
})({});
