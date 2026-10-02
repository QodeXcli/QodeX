/*
 * Seven Gum Commerce — widget live refresh.
 * Polls REST endpoint every 60s, updates price + stock chip in place.
 */
(function () {
	if (!window.SG_COMMERCE || !window.SG_COMMERCE.rest) return;
	var REST = window.SG_COMMERCE.rest;
	var REFRESH_MS = 60 * 1000;

	function refresh(el) {
		var sku = el.dataset.sku;
		var market = el.dataset.market;
		if (!sku || !market) return;

		fetch(REST + 'product/' + encodeURIComponent(market) + '/' + encodeURIComponent(sku), {
			headers: { 'Accept': 'application/json' }
		})
			.then(function(r) { return r.ok ? r.json() : null; })
			.then(function(data) {
				if (!data) return;
				var priceEl = el.querySelector('[data-role="price"]');
				if (priceEl && data.price !== null && typeof data.price !== 'undefined') {
					var small = priceEl.querySelector('small');
					priceEl.textContent = Number(data.price).toFixed(2) + ' ';
					if (small) priceEl.appendChild(small);
					else {
						var s = document.createElement('small');
						s.textContent = data.currency || '';
						priceEl.appendChild(s);
					}
				}
				var stockEl = el.querySelector('[data-role="stock"]');
				if (stockEl) {
					stockEl.textContent = data.in_stock ? 'In stock' : 'Out of stock';
					stockEl.classList.toggle('sg-widget__stock--ok', !!data.in_stock);
					stockEl.classList.toggle('sg-widget__stock--out', !data.in_stock);
				}
			})
			.catch(function() { /* silent */ });
	}

	function init() {
		var widgets = document.querySelectorAll('.sg-widget[data-sku][data-market]');
		widgets.forEach(function(w) {
			setInterval(function() { refresh(w); }, REFRESH_MS);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
