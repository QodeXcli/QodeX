/*!
 * Amazon Seller Suite — wp-admin single-page app.
 * Vanilla JS (no build step), talks to /wp-json/sg-commerce/v1/suite/*.
 */
(function () {
	'use strict';

	var CFG = window.SGSuite || {};
	var root = document.getElementById('sgs-app');
	if (!root) { return; }

	/* ================================================================== */
	/* State                                                              */
	/* ================================================================== */

	var LS_KEY = 'sgsuite.v1';
	var saved = {};
	try { saved = JSON.parse(window.localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { saved = {}; }

	var state = {
		market: saved.market || CFG.primary || 'US',
		preset: saved.preset || '30',
		from: null,
		to: null,
		demo: !!CFG.demo,
		connected: !!CFG.connected,
		ads: !!CFG.ads,
		unread: 0
	};

	function persist() {
		try { window.localStorage.setItem(LS_KEY, JSON.stringify({ market: state.market, preset: state.preset })); } catch (e) { /* private mode */ }
	}

	function marketInfo() {
		var m = (CFG.markets || []).filter(function (x) { return x.code === state.market; })[0];
		return m || { code: state.market, currency: 'USD', tld: 'com' };
	}

	/* ================================================================== */
	/* Utilities                                                          */
	/* ================================================================== */

	function h(tag, attrs) {
		var el = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				var v = attrs[k];
				if (v === null || v === undefined || v === false) { return; }
				if (k === 'class') { el.className = v; }
				else if (k === 'html') { el.innerHTML = v; }
				else if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); }
				else if (k.indexOf('on') === 0 && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
				else if (v === true) { el.setAttribute(k, ''); }
				else { el.setAttribute(k, v); }
			});
		}
		for (var i = 2; i < arguments.length; i++) { add(el, arguments[i]); }
		return el;
	}
	function add(el, c) {
		if (c === null || c === undefined || c === false) { return; }
		if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
		el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } return el; }

	function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
	function money(v, digits) {
		if (v === null || v === undefined || v === '') { return '—'; }
		if (typeof digits !== 'number') { digits = undefined; } // table fmt() passes the row as 2nd arg
		var cur = marketInfo().currency || 'USD';
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: digits === undefined ? 2 : digits, maximumFractionDigits: digits === undefined ? 2 : digits }).format(num(v));
		} catch (e) { return cur + ' ' + num(v).toFixed(2); }
	}
	function money0(v) { return money(v, 0); }
	function int(v) { if (v === null || v === undefined || v === '') { return '—'; } return Math.round(num(v)).toLocaleString(); }
	function pct(v, d) { if (v === null || v === undefined || v === '') { return '—'; } return num(v).toFixed(d === undefined ? 1 : d) + '%'; }
	function signed(v, fn) { var s = (fn || money)(v); return num(v) > 0 ? '+' + s : s; }
	function tone(v) { return num(v) > 0 ? 'pos' : (num(v) < 0 ? 'neg' : ''); }
	function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function shortDate(d) { if (!d) { return '—'; } var x = new Date(String(d).replace(' ', 'T') + (String(d).length <= 10 ? 'T00:00:00' : '')); return isNaN(x) ? d : x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
	function dateTime(d) { if (!d) { return '—'; } var x = new Date(String(d).replace(' ', 'T') + 'Z'); return isNaN(x) ? d : x.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
	function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
	function addDays(s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
	function amazonUrl(asin) { return 'https://www.amazon.' + (marketInfo().tld || 'com') + '/dp/' + encodeURIComponent(asin); }
	function delta(cur, prev, invert) {
		cur = num(cur); prev = num(prev);
		if (!prev) { return null; }
		var d = (cur - prev) / Math.abs(prev) * 100;
		var good = invert ? d < 0 : d > 0;
		return h('span', { class: 'delta ' + (good ? 'up' : 'down') }, (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1) + '%');
	}

	function rangeParams() {
		var today = ymd(new Date());
		if (state.preset === 'custom' && state.from && state.to) { return { from: state.from, to: state.to }; }
		if (state.preset === 'mtd') { return { from: today.slice(0, 8) + '01', to: today }; }
		if (state.preset === 'lm') {
			var d = new Date(); d.setDate(1); d.setDate(0);
			return { from: ymd(d).slice(0, 8) + '01', to: ymd(d) };
		}
		if (state.preset === 'ytd') { return { from: today.slice(0, 5) + '01-01', to: today }; }
		var n = parseInt(state.preset, 10) || 30;
		return { from: addDays(today, -(n - 1)), to: today };
	}

	/* ================================================================== */
	/* API                                                                */
	/* ================================================================== */

	function api(path, opts) {
		opts = opts || {};
		var url = String(CFG.root || '').replace(/\/$/, '') + path;
		var q = Object.assign({ market: state.market }, opts.query || {});
		var qs = Object.keys(q).filter(function (k) { return q[k] !== undefined && q[k] !== null && q[k] !== ''; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
		url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
		var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': CFG.nonce, 'Accept': 'application/json' } };
		if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
		return fetch(url, init).then(function (res) {
			return res.text().then(function (txt) {
				var data = null;
				try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
				if (!res.ok) {
					var msg = (data && (data.message || data.code)) || ('HTTP ' + res.status);
					throw new Error(msg);
				}
				return data;
			});
		});
	}

	/* ================================================================== */
	/* UI components                                                      */
	/* ================================================================== */

	var toasts = h('div', { class: 'sgs-toasts' });
	document.body.appendChild(toasts);
	function toast(msg, kind) {
		var t = h('div', { class: 'sgs-toast ' + (kind || '') }, msg);
		toasts.appendChild(t);
		setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 3500);
	}

	function btn(label, onClick, cls, attrs) {
		var b = h('button', Object.assign({ type: 'button', class: 'btn ' + (cls || '') }, attrs || {}), label);
		b.addEventListener('click', function (e) {
			if (b.disabled) { return; }
			var r = onClick(e, b);
			if (r && typeof r.then === 'function') {
				var old = b.textContent;
				b.disabled = true; b.textContent = '…';
				r.then(function () { b.disabled = false; b.textContent = old; }, function (err) { b.disabled = false; b.textContent = old; toast(err.message || String(err), 'bad'); });
			}
		});
		return b;
	}

	function card(title, body, opts) {
		opts = opts || {};
		return h('div', { class: 'sgs-card' + (opts.flush ? ' flush' : '') },
			(title || opts.actions) ? h('div', { class: 'sgs-card-head' }, h('div', null, title ? h('h3', null, title) : null, opts.sub ? h('p', null, opts.sub) : null), opts.actions || null) : null,
			body);
	}

	function kpi(label, value, sub, cls) {
		return h('div', { class: 'sgs-kpi ' + (cls || '') }, h('div', { class: 'lbl' }, label), h('div', { class: 'val', title: typeof value === 'string' ? value : '' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
	}

	function badge(text, color) { return h('span', { class: 'b ' + (color || '') }, text); }

	function empty(title, text, action) {
		return h('div', { class: 'sgs-empty' }, h('b', null, title), text ? h('div', null, text) : null, action ? h('div', { style: { marginTop: '12px' } }, action) : null);
	}

	function meter(p, color) {
		p = Math.max(0, Math.min(100, num(p)));
		return h('div', { class: 'meter ' + (color || '') }, h('i', { style: { width: p + '%' } }));
	}

	function seg(options, value, onChange) {
		var wrap = h('div', { class: 'seg' });
		options.forEach(function (o) {
			wrap.appendChild(h('button', { type: 'button', class: o[0] === value ? 'on' : '', onclick: function () { onChange(o[0]); } }, o[1]));
		});
		return wrap;
	}

	function field(label, input, help) {
		return h('div', { class: 'field' }, h('label', null, label), input, help ? h('small', null, help) : null);
	}

	function drawer(title, content, actions) {
		var bg = h('div', { class: 'sgs-drawer-bg' });
		var body = h('div', { class: 'body' }, content);
		var close = function () { bg.remove(); panel.remove(); document.removeEventListener('keydown', onKey); };
		var onKey = function (e) { if (e.key === 'Escape') { close(); } };
		var panel = h('div', { class: 'sgs-drawer sgs', role: 'dialog', 'aria-label': title },
			h('header', null, h('h2', null, title), h('div', { class: 'btns' }, actions || null, btn('Close', close, 'ghost'))),
			body);
		bg.addEventListener('click', close);
		document.addEventListener('keydown', onKey);
		document.body.appendChild(bg);
		document.body.appendChild(panel);
		return { close: close, body: body };
	}

	function copy(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard', 'ok'); });
		}
		var ta = h('textarea', null, text); document.body.appendChild(ta); ta.select();
		try { document.execCommand('copy'); toast('Copied to clipboard', 'ok'); } catch (e) { /* ignore */ }
		ta.remove();
		return Promise.resolve();
	}

	function downloadCsv(name, columns, rows) {
		var cols = columns.filter(function (c) { return c.key && c.csv !== false; });
		var lines = [cols.map(function (c) { return '"' + String(c.label).replace(/"/g, '""') + '"'; }).join(',')];
		rows.forEach(function (r) {
			lines.push(cols.map(function (c) {
				var v = c.csvValue ? c.csvValue(r) : r[c.key];
				if (v === null || v === undefined) { v = ''; }
				return '"' + String(v).replace(/"/g, '""') + '"';
			}).join(','));
		});
		var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
		var a = h('a', { href: URL.createObjectURL(blob), download: name + '-' + ymd(new Date()) + '.csv' });
		document.body.appendChild(a); a.click(); a.remove();
	}

	/**
	 * Sortable, searchable, paginated table with CSV export.
	 * columns: [{key, label, align:'r'|'c', fmt(v,row), render(row)->Node, sort:false, sum:true}]
	 */
	function table(opts) {
		var cols = opts.columns;
		var all = (opts.rows || []).slice();
		var sortKey = opts.sort || null;
		var sortDir = opts.dir || -1;
		var page = 0;
		var per = opts.per || 50;
		var query = '';
		var selected = {};

		var wrap = h('div', { class: 'sgs-card flush' });
		var tbody = h('tbody');
		var tfoot = h('tfoot');
		var pager = h('div', { class: 'sgs-pager' });
		var thead = h('thead');
		var search = opts.search === false ? null : h('input', { type: 'text', placeholder: opts.placeholder || 'Search…', oninput: function (e) { query = e.target.value.toLowerCase(); page = 0; draw(); } });

		var tools = h('div', { class: 'sgs-table-tools' },
			h('div', { class: 'btns' }, search, opts.tools || null),
			h('div', { class: 'btns' }, opts.selectable ? opts.bulk(function () { return all.filter(function (r) { return selected[r[opts.selectable]]; }); }) : null,
				opts.csv ? btn('Export CSV', function () { downloadCsv(opts.csv, cols, filtered()); }, 'sm') : null));

		if (opts.title) {
			wrap.appendChild(h('div', { class: 'sgs-card-head' }, h('div', null, h('h3', null, opts.title), opts.sub ? h('p', null, opts.sub) : null), opts.actions || null));
		}
		wrap.appendChild(tools);
		wrap.appendChild(h('div', { class: 'sgs-table-wrap' }, h('table', { class: 't' }, thead, tbody, tfoot)));
		wrap.appendChild(pager);

		function filtered() {
			var rows = all;
			if (query) {
				rows = rows.filter(function (r) {
					return cols.some(function (c) { var v = r[c.key]; return v !== null && v !== undefined && String(v).toLowerCase().indexOf(query) >= 0; });
				});
			}
			if (sortKey) {
				rows = rows.slice().sort(function (a, b) {
					var x = a[sortKey], y = b[sortKey];
					var nx = parseFloat(x), ny = parseFloat(y);
					if (!isNaN(nx) && !isNaN(ny) && String(nx) !== 'NaN') { return (nx - ny) * sortDir; }
					if (x === null || x === undefined) { return 1; }
					if (y === null || y === undefined) { return -1; }
					return String(x).localeCompare(String(y)) * sortDir;
				});
			}
			return rows;
		}

		function head() {
			clear(thead);
			var tr = h('tr');
			if (opts.selectable) {
				var cb = h('input', { type: 'checkbox', onchange: function (e) { filtered().forEach(function (r) { selected[r[opts.selectable]] = e.target.checked; }); draw(); } });
				tr.appendChild(h('th', { style: { width: '28px' } }, cb));
			}
			cols.forEach(function (c) {
				var th = h('th', { class: c.align || '', title: c.title || '' }, c.label, sortKey === c.key ? h('span', { class: 'arrow' }, sortDir > 0 ? '▲' : '▼') : null);
				if (c.sort !== false && c.key) {
					th.addEventListener('click', function () { if (sortKey === c.key) { sortDir = -sortDir; } else { sortKey = c.key; sortDir = -1; } draw(); });
				}
				tr.appendChild(th);
			});
			thead.appendChild(tr);
		}

		function draw() {
			head();
			clear(tbody); clear(tfoot); clear(pager);
			var rows = filtered();
			if (!rows.length) {
				tbody.appendChild(h('tr', null, h('td', { colspan: cols.length + (opts.selectable ? 1 : 0) }, opts.empty || empty('Nothing here yet', 'No rows match.'))));
				return;
			}
			var pages = Math.ceil(rows.length / per);
			page = Math.min(page, pages - 1);
			rows.slice(page * per, page * per + per).forEach(function (r) {
				var tr = h('tr', { class: opts.onRow ? 'click' : '' });
				if (opts.selectable) {
					var id = r[opts.selectable];
					tr.appendChild(h('td', { onclick: function (e) { e.stopPropagation(); } }, h('input', { type: 'checkbox', checked: !!selected[id], onchange: function (e) { selected[id] = e.target.checked; } })));
				}
				cols.forEach(function (c) {
					var content = c.render ? c.render(r) : (c.fmt ? c.fmt(r[c.key], r) : (r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? '—' : r[c.key]));
					var cls = (c.align || '') + (c.tone ? ' ' + tone(r[c.key]) : '') + (c.mono ? ' mono' : '');
					tr.appendChild(h('td', { class: cls }, content));
				});
				if (opts.onRow) { tr.addEventListener('click', function () { opts.onRow(r); }); }
				tbody.appendChild(tr);
			});
			if (cols.some(function (c) { return c.sum; })) {
				var ft = h('tr');
				if (opts.selectable) { ft.appendChild(h('td')); }
				cols.forEach(function (c, i) {
					if (c.sum) {
						var s = rows.reduce(function (a, r) { return a + num(r[c.key]); }, 0);
						ft.appendChild(h('td', { class: (c.align || '') + (c.tone ? ' ' + tone(s) : '') }, c.fmt ? c.fmt(s, {}) : s));
					} else {
						ft.appendChild(h('td', { class: c.align || '' }, i === 0 ? 'Total (' + rows.length + ')' : ''));
					}
				});
				tfoot.appendChild(ft);
			}
			if (pages > 1) {
				pager.appendChild(h('span', null, (page * per + 1) + '–' + Math.min(rows.length, page * per + per) + ' of ' + rows.length));
				pager.appendChild(btn('‹', function () { page = Math.max(0, page - 1); draw(); }, 'sm', { disabled: page === 0 }));
				pager.appendChild(btn('›', function () { page = Math.min(pages - 1, page + 1); draw(); }, 'sm', { disabled: page >= pages - 1 }));
			} else {
				pager.appendChild(h('span', null, rows.length + ' rows'));
			}
		}

		draw();
		wrap.setRows = function (rows) { all = rows.slice(); selected = {}; draw(); };
		wrap.clearSelection = function () { selected = {}; draw(); };
		return wrap;
	}

	/* ------------------------------------------------------------------ */
	/* SVG charts                                                         */
	/* ------------------------------------------------------------------ */

	var NS = 'http://www.w3.org/2000/svg';
	function s(tag, attrs) {
		var el = document.createElementNS(NS, tag);
		Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
		for (var i = 2; i < arguments.length; i++) { if (arguments[i]) { el.appendChild(arguments[i]); } }
		return el;
	}

	function niceMax(v) {
		if (v <= 0) { return 1; }
		var p = Math.pow(10, Math.floor(Math.log10(v)));
		var n = v / p;
		return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
	}

	/**
	 * chart({labels, series:[{label, values, type:'bar'|'line'|'area', color, axis:'left'|'right', fmt}], height, fmt})
	 */
	function chart(o) {
		var W = 900, H = o.height || 240, pl = 56, pr = o.series.some(function (x) { return x.axis === 'right'; }) ? 56 : 14, pt = 10, pb = 26;
		var iw = W - pl - pr, ih = H - pt - pb;
		var labels = o.labels || [];
		var n = Math.max(1, labels.length);
		function range(axis) {
			var vals = [];
			o.series.filter(function (x) { return (x.axis || 'left') === axis; }).forEach(function (x) { x.values.forEach(function (v) { if (v !== null && v !== undefined) { vals.push(num(v)); } }); });
			var max = Math.max.apply(null, vals.concat([0])), min = Math.min.apply(null, vals.concat([0]));
			var top = niceMax(Math.max(max, Math.abs(min) * 0.2));
			var bottom = min < 0 ? -niceMax(Math.abs(min)) : 0;
			return [bottom, top];
		}
		var L = range('left'), R = range('right');
		function y(v, axis) { var r = axis === 'right' ? R : L; return pt + ih - (num(v) - r[0]) / (r[1] - r[0] || 1) * ih; }
		function x(i) { return pl + (i + 0.5) * (iw / n); }

		var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', height: H, role: 'img', 'aria-label': o.title || 'chart' });
		var grid = s('g', { class: 'grid' });
		var axis = s('g', { class: 'axis' });
		for (var g = 0; g <= 4; g++) {
			var vy = L[0] + (L[1] - L[0]) * g / 4;
			var yy = y(vy, 'left');
			grid.appendChild(s('line', { x1: pl, x2: W - pr, y1: yy, y2: yy }));
			var t = s('text', { x: pl - 8, y: yy + 3, 'text-anchor': 'end' }); t.textContent = (o.fmt || money0)(vy); axis.appendChild(t);
			if (pr > 20) {
				var vr = R[0] + (R[1] - R[0]) * g / 4;
				var tr = s('text', { x: W - pr + 8, y: y(vr, 'right') + 3, 'text-anchor': 'start' });
				tr.textContent = (o.series.filter(function (x) { return x.axis === 'right'; })[0].fmt || int)(vr); axis.appendChild(tr);
			}
		}
		var step = Math.max(1, Math.ceil(n / 10));
		labels.forEach(function (l, i) {
			if (i % step !== 0 && i !== n - 1) { return; }
			var t = s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }); t.textContent = o.labelFmt ? o.labelFmt(l) : shortDate(l); axis.appendChild(t);
		});
		svg.appendChild(grid); svg.appendChild(axis);
		if (L[0] < 0) { svg.appendChild(s('line', { x1: pl, x2: W - pr, y1: y(0, 'left'), y2: y(0, 'left'), stroke: '#cbd5e1' })); }

		var bars = o.series.filter(function (x) { return x.type === 'bar'; });
		var bw = Math.max(2, (iw / n) * 0.72 / Math.max(1, bars.length));
		bars.forEach(function (ser, si) {
			ser.values.forEach(function (v, i) {
				if (v === null || v === undefined) { return; }
				var y0 = y(0, ser.axis), y1 = y(v, ser.axis);
				var xx = x(i) - (bw * bars.length) / 2 + si * bw;
				svg.appendChild(s('rect', { x: xx, y: Math.min(y0, y1), width: bw - 1, height: Math.max(1, Math.abs(y1 - y0)), rx: 2, fill: ser.color, opacity: 0.9 }));
			});
		});
		o.series.filter(function (x) { return x.type !== 'bar'; }).forEach(function (ser) {
			var d = '';
			ser.values.forEach(function (v, i) { if (v === null || v === undefined) { return; } d += (d ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v, ser.axis).toFixed(1); });
			if (!d) { return; }
			if (ser.type === 'area') {
				svg.appendChild(s('path', { d: d + 'L' + x(n - 1) + ',' + y(0, ser.axis) + 'L' + x(0) + ',' + y(0, ser.axis) + 'Z', fill: ser.color, opacity: 0.1 }));
			}
			svg.appendChild(s('path', { d: d, fill: 'none', stroke: ser.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
		});

		var wrap = h('div', { class: 'sgs-chart' });
		var tip = h('div', { class: 'tip', style: { display: 'none' } });
		var cursor = s('line', { y1: pt, y2: pt + ih, stroke: '#94a3b8', 'stroke-dasharray': '3 3', opacity: 0 });
		svg.appendChild(cursor);
		svg.addEventListener('mousemove', function (e) {
			var rect = svg.getBoundingClientRect();
			var px = (e.clientX - rect.left) / rect.width * W;
			var i = Math.max(0, Math.min(n - 1, Math.floor((px - pl) / (iw / n))));
			cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('opacity', 1);
			clear(tip);
			tip.appendChild(h('b', null, o.labelFmt ? o.labelFmt(labels[i]) : shortDate(labels[i])));
			o.series.forEach(function (ser) {
				tip.appendChild(h('div', null, h('i', { style: { background: ser.color } }), ser.label + ': ', (ser.fmt || o.fmt || money)(ser.values[i])));
			});
			tip.style.display = 'block';
			tip.style.left = (x(i) / W * 100) + '%';
			tip.style.top = ((e.clientY - rect.top)) + 'px';
		});
		svg.addEventListener('mouseleave', function () { tip.style.display = 'none'; cursor.setAttribute('opacity', 0); });
		wrap.appendChild(svg); wrap.appendChild(tip);
		var legend = h('div', { class: 'sgs-legend' });
		o.series.forEach(function (ser) { legend.appendChild(h('span', null, h('i', { style: { background: ser.color } }), ser.label)); });
		return h('div', null, legend, h('div', { style: { height: '8px' } }), wrap);
	}

	function sparkline(values, color, w, hgt) {
		w = w || 90; hgt = hgt || 24;
		var vals = values.map(num);
		var max = Math.max.apply(null, vals.concat([0.0001])), min = Math.min.apply(null, vals.concat([0]));
		var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + (i / Math.max(1, vals.length - 1) * w).toFixed(1) + ',' + (hgt - 2 - (v - min) / (max - min || 1) * (hgt - 4)).toFixed(1); }).join('');
		return s('svg', { width: w, height: hgt, class: 'spark' }, s('path', { d: d, fill: 'none', stroke: color || '#2563eb', 'stroke-width': 1.6 }));
	}

	var C = { sales: '#2563eb', profit: '#059669', ads: '#f59e0b', refunds: '#dc2626', fees: '#94a3b8', units: '#7c3aed', grey: '#cbd5e1' };

	/* ================================================================== */
	/* Shell                                                              */
	/* ================================================================== */

	var ROUTES = [
		['', 'Dashboard'], ['profit', 'Profit'], ['orders', 'Orders'], ['restock', 'Inventory'], ['ppc', 'PPC'],
		['keywords', 'Keywords'], ['listings', 'Listings'], ['monitor', 'Hijackers & Buy Box'], ['reviews', 'Reviews'],
		['reimbursements', 'Reimbursements'], ['analytics', 'Traffic & Returns'], ['research', 'Research'],
		['reports', 'Reports'], ['alerts', 'Alerts'], ['settings', 'Settings']
	];

	var headerSlot = h('div');
	var nav = h('nav', { class: 'sgs-nav', 'aria-label': 'Amazon Suite sections' });
	var bannerSlot = h('div');
	var main = h('main');

	function header() {
		var sel = h('select', { 'aria-label': 'Marketplace', onchange: function (e) { state.market = e.target.value; persist(); route(); } });
		(CFG.markets || [{ code: state.market }]).forEach(function (m) { sel.appendChild(h('option', { value: m.code, selected: m.code === state.market }, m.code + (m.currency ? ' · ' + m.currency : ''))); });
		return h('div', { class: 'sgs-top' },
			h('div', { class: 'sgs-brand' }, h('div', { class: 'sgs-logo' }, '7'), h('div', null, h('h1', null, 'Amazon Seller Suite'), h('small', null, 'Profit · PPC · Inventory · Reviews · Reimbursements · Protection'))),
			h('div', { class: 'sgs-controls' },
				h('span', { class: 'sgs-pill ' + (state.connected ? 'ok' : 'bad') }, h('span', { class: 'dot' }), state.connected ? 'SP-API connected' : 'SP-API not connected'),
				h('span', { class: 'sgs-pill ' + (state.ads ? 'ok' : 'warn') }, h('span', { class: 'dot' }), state.ads ? 'Ads API connected' : 'Ads API off'),
				state.demo ? h('span', { class: 'sgs-pill' }, '🧪 Demo data') : null,
				sel));
	}

	function rangeBar(onChange) {
		var r = rangeParams();
		var from = h('input', { type: 'date', value: r.from, onchange: function () { state.preset = 'custom'; state.from = from.value; state.to = to.value; persist(); onChange(); } });
		var to = h('input', { type: 'date', value: r.to, onchange: function () { state.preset = 'custom'; state.from = from.value; state.to = to.value; persist(); onChange(); } });
		return h('div', { class: 'btns' },
			seg([['7', '7D'], ['14', '14D'], ['30', '30D'], ['mtd', 'MTD'], ['lm', 'Last month'], ['90', '90D'], ['ytd', 'YTD']], state.preset, function (v) { state.preset = v; persist(); onChange(); }),
			from, h('span', { class: 'muted' }, '→'), to);
	}

	function pageHead(title, sub, actions) {
		return h('div', { class: 'sgs-page-head' }, h('div', null, h('h2', null, title), sub ? h('p', null, sub) : null), actions ? h('div', { class: 'btns' }, actions) : null);
	}

	function banners() {
		clear(bannerSlot);
		if (state.demo) {
			bannerSlot.appendChild(h('div', { class: 'sgs-banner demo' },
				h('span', null, h('b', null, 'Demo mode. '), 'You are looking at a realistic sample account for the 7 SEVEN catalog. Clear it any time; your real data is never touched.'),
				btn('Clear demo data', function () { return api('/demo', { method: 'DELETE' }).then(function () { state.demo = false; toast('Demo data removed', 'ok'); route(); }); }, 'sm')));
		} else if (!state.connected) {
			bannerSlot.appendChild(h('div', { class: 'sgs-banner warn' },
				h('span', null, h('b', null, 'Amazon is not connected yet. '), 'Add your LWA credentials under Seven Gum → Amazon Connect, or explore with a demo account first.'),
				h('div', { class: 'btns' },
					h('a', { class: 'btn sm', href: CFG.coreUrl }, 'Connect Amazon'),
					btn('Load demo account', function () { return seedDemo(); }, 'sm primary'))));
		}
	}

	function seedDemo() {
		toast('Building the demo account (≈20–40 s)…');
		return api('/demo', { method: 'POST' }).then(function () { state.demo = true; toast('Demo account ready', 'ok'); route(); });
	}

	function drawNav(active) {
		clear(nav);
		ROUTES.forEach(function (r) {
			nav.appendChild(h('a', { href: '#/' + r[0], class: r[0] === active ? 'on' : '' }, r[1], r[0] === 'alerts' && state.unread ? h('span', { class: 'badge' }, state.unread) : null));
		});
	}

	function loading() {
		return h('div', { class: 'sgs-stack' }, h('div', { class: 'sgs-grid k4' }, [1, 2, 3, 4].map(function () { return h('div', { class: 'skeleton' }); })), h('div', { class: 'skeleton', style: { minHeight: '260px' } }));
	}

	function failure(err) {
		return h('div', { class: 'sgs-banner bad' }, h('span', null, h('b', null, 'Could not load this view. '), err.message || String(err)), btn('Retry', route, 'sm'));
	}

	var token = 0;
	function route() {
		var hash = (window.location.hash || '').replace(/^#\/?/, '');
		var name = hash.split('?')[0];
		var page = PAGES[name] ? name : '';
		drawNav(page);
		clear(headerSlot).appendChild(header());
		banners();
		clear(main).appendChild(loading());
		var my = ++token;
		Promise.resolve().then(function () { return PAGES[page](); }).then(function (node) {
			if (my !== token) { return; }
			// Pages may refresh connection/demo/unread state — redraw the chrome for the CURRENT route only.
			drawNav(page);
			clear(headerSlot).appendChild(header());
			banners();
			clear(main).appendChild(node);
		}).catch(function (err) {
			if (my !== token) { return; }
			clear(main).appendChild(failure(err));
		});
	}

	/* ================================================================== */
	/* Pages                                                              */
	/* ================================================================== */

	var PAGES = {};

	/* ---------- Dashboard ---------- */
	PAGES[''] = function () {
		return api('/overview').then(function (d) {
			state.unread = d.unread || 0;
			state.connected = d.connected; state.ads = d.ads_ready; state.demo = d.demo;
			var P = d.periods;
			function period(key, title, hl) {
				var t = P[key];
				return h('div', { class: 'sgs-period' + (hl ? ' hl' : '') },
					h('div', { class: 'head' }, h('b', null, title), h('span', null, t.from === t.to ? shortDate(t.from) : shortDate(t.from) + ' – ' + shortDate(t.to))),
					h('div', { class: 'big' }, money(t.sales)),
					h('dl', null,
						h('dt', null, 'Orders / units'), h('dd', null, int(t.orders) + ' / ' + int(t.units)),
						h('dt', null, 'Ad spend'), h('dd', null, money(-t.ads)),
						h('dt', null, 'Amazon fees'), h('dd', null, money(-t.amazon_fees)),
						h('dt', null, 'Net profit'), h('dd', { class: hl ? '' : tone(t.net_profit) }, money(t.net_profit)),
						h('dt', null, 'Margin'), h('dd', null, pct(t.margin_pct))));
			}
			var F = P.forecast;
			var kpis = h('div', { class: 'sgs-grid k5' },
				period('today', 'Today', true), period('yesterday', 'Yesterday'), period('mtd', 'Month to date'),
				h('div', { class: 'sgs-period' },
					h('div', { class: 'head' }, h('b', null, 'Forecast this month'), h('span', null, F.basis || '')),
					h('div', { class: 'big' }, money(F.sales)),
					h('dl', null, h('dt', null, 'Units'), h('dd', null, int(F.units)), h('dt', null, 'Net profit'), h('dd', { class: tone(F.net_profit) }, money(F.net_profit)))),
				period('last_month', 'Last month'));

			var series = d.series || [];
			var trend = card('Sales & net profit — last 30 days', chart({
				labels: series.map(function (r) { return r.date; }),
				series: [
					{ label: 'Sales', values: series.map(function (r) { return r.sales; }), type: 'bar', color: C.sales },
					{ label: 'Net profit', values: series.map(function (r) { return r.net_profit; }), type: 'line', color: C.profit },
					{ label: 'Ad spend', values: series.map(function (r) { return r.ads; }), type: 'line', color: C.ads }
				]
			}));

			var T = d.totals_30;
			var unit = h('div', { class: 'sgs-grid k4' },
				kpi('30-day net profit', money(T.net_profit), 'Margin ' + pct(T.margin_pct) + ' · ROI ' + pct(T.roi_pct), num(T.net_profit) >= 0 ? 'tone-green' : 'tone-red'),
				kpi('TACoS', pct(T.tacos_pct), 'ACoS ' + pct(T.acos_pct) + ' · spend ' + money(-T.ads)),
				kpi('Conversion rate', pct(d.conversion), int(d.sessions) + ' sessions'),
				kpi('Refund rate', pct(T.refund_rate_pct), money(-T.refunds) + ' refunded'));

			var actions = h('div', { class: 'sgs-grid k3' });
			function act(icon, color, title, sub, href) { actions.appendChild(h('a', { class: 'action-card', href: href }, h('div', { class: 'ic ' + color }, icon), h('div', null, h('b', null, title), h('span', null, sub)))); }
			var R = d.restock;
			act('📦', R.reorder || R.out_of_stock ? 'red' : 'green', R.out_of_stock + ' out of stock · ' + R.reorder + ' to reorder', R.lost_sales_per_day > 0 ? 'Losing ≈' + money(R.lost_sales_per_day) + '/day in sales' : 'Suggested PO: ' + int(R.order_units) + ' units (' + money0(R.order_value) + ')', '#/restock');
			act('🛡️', d.buybox.hijacked ? 'red' : 'green', d.buybox.hijacked ? d.buybox.hijacked + ' listing(s) with other sellers' : 'No hijackers detected', 'Buy Box held on ' + d.buybox.winning + '/' + d.buybox.asins + ' ASINs (' + pct(d.buybox.pct) + ')', '#/monitor');
			act('💸', d.reimburse.open ? 'amber' : 'green', money(d.reimburse.value) + ' recoverable', d.reimburse.open + ' open reimbursement case(s) ready to file', '#/reimbursements');
			act('🎯', 'blue', 'PPC: ' + money(d.ads.wasted_spend) + ' wasted spend', 'Search terms with clicks but no orders (30 days) · ROAS ' + (d.ads.roas || '—'), '#/ppc');
			act('📝', d.listings.avg_score !== null && d.listings.avg_score < 80 ? 'amber' : 'green', 'Listing score ' + (d.listings.avg_score === null ? '—' : d.listings.avg_score + '/100'), d.listings.audited + ' listing(s) audited', '#/listings');
			act('⭐', 'violet', int(d.reviews.sent) + ' review requests sent', '30 days · ' + int(d.reviews.ineligible) + ' ineligible', '#/reviews');

			var top = table({
				title: 'Top products — 30 days', search: false, per: 8, sort: 'sales',
				columns: [
					{ key: 'sku', label: 'SKU', render: function (r) { return h('div', null, h('b', null, r.sku), h('span', { class: 'title muted small' }, r.title)); } },
					{ key: 'units', label: 'Units', align: 'r', fmt: int },
					{ key: 'sales', label: 'Sales', align: 'r', fmt: money },
					{ key: 'net_profit', label: 'Net profit', align: 'r', fmt: money, tone: true },
					{ key: 'margin_pct', label: 'Margin', align: 'r', fmt: function (v) { return pct(v); } }
				],
				rows: d.top_skus
			});
			var alerts = card('Latest alerts', d.alerts && d.alerts.length ? h('ul', { class: 'list' }, d.alerts.map(function (a) {
				return h('li', null, h('div', null, h('b', null, a.title), h('div', { class: 'small muted' }, dateTime(a.created_at))), badge(a.level, a.level === 'critical' ? 'red' : (a.level === 'warning' ? 'amber' : 'blue')));
			})) : empty('All quiet', 'No alerts yet.'), { actions: h('a', { href: '#/alerts', class: 'btn sm' }, 'All alerts') });

			var missing = d.missing_costs && d.missing_costs.length ? h('div', { class: 'sgs-banner warn' }, h('span', null, h('b', null, d.missing_costs.length + ' SKU(s) have no product cost — '), 'profit is overstated until you add COGS.'), h('a', { class: 'btn sm', href: '#/profit?tab=costs' }, 'Add costs')) : null;

			return h('div', { class: 'sgs-stack' },
				pageHead('Dashboard', 'Live net profit after every Amazon fee, refund, ad dollar and unit cost — plus everything that needs your attention today.', [btn('Refresh', route, 'sm')]),
				missing, kpis, h('div', { class: 'sgs-grid k21' }, trend, alerts), unit, actions, top);
		});
	};

	/* ---------- Profit ---------- */
	PAGES.profit = function () {
		var tab = (window.location.hash.split('tab=')[1] || 'pnl');
		var wrap = h('div', { class: 'sgs-stack' });
		var body = h('div');
		function setTab(t) { tab = t; history.replaceState(null, '', '#/profit?tab=' + t); draw(); }
		function draw() {
			clear(wrap);
			wrap.appendChild(pageHead('Profit & P&L', 'Sellerboard-grade profit: settled fees by order, estimated fees for unsettled orders, refunds, storage, ads, COGS and your own expenses.', [seg([['pnl', 'P&L'], ['costs', 'Product costs (COGS)'], ['expenses', 'Expenses']], tab, setTab)]));
			wrap.appendChild(body);
			clear(body).appendChild(loading());
			(tab === 'costs' ? costsView() : tab === 'expenses' ? expensesView() : pnlView()).then(function (n) { clear(body).appendChild(n); }, function (e) { clear(body).appendChild(failure(e)); });
		}
		function pnlView() {
			return api('/profit', { query: rangeParams() }).then(function (d) {
				var T = d.totals, P = d.previous || {};
				var k = h('div', { class: 'sgs-grid k5' },
					kpi('Sales', h('span', null, money(T.sales), delta(T.sales, P.sales)), int(T.orders) + ' orders · ' + int(T.units) + ' units'),
					kpi('Net profit', h('span', null, money(T.net_profit), delta(T.net_profit, P.net_profit)), 'Margin ' + pct(T.margin_pct), num(T.net_profit) >= 0 ? 'tone-green' : 'tone-red'),
					kpi('ROI', pct(T.roi_pct), 'on ' + money(-T.cogs) + ' COGS'),
					kpi('Amazon fees', money(-(T.amazon_fees + T.account_fees)), pct(T.sales ? -(T.amazon_fees + T.account_fees) / T.sales * 100 : null) + ' of sales' + (T.fees_estimated ? ' · ' + money(-T.fees_estimated) + ' estimated' : '')),
					kpi('Ad spend', money(-T.ads), 'TACoS ' + pct(T.tacos_pct) + ' · ACoS ' + pct(T.acos_pct)));

				var max = Math.max.apply(null, d.waterfall.map(function (w) { return Math.abs(num(w.value)); }).concat([1]));
				var wf = h('div', { class: 'wf' });
				d.waterfall.forEach(function (w) {
					var v = num(w.value);
					wf.appendChild(h('div', null, w.label));
					wf.appendChild(h('div', { class: 'bar' }, h('i', { style: { left: '0', width: (Math.abs(v) / max * 100) + '%', background: v >= 0 ? C.profit : C.refunds, opacity: 0.8 } })));
					wf.appendChild(h('div', { class: 'v ' + tone(v) }, money(v)));
				});
				wf.appendChild(h('div', { class: 'total' }, 'Net profit'));
				wf.appendChild(h('div', { class: 'bar' }, h('i', { style: { width: (Math.abs(num(T.net_profit)) / max * 100) + '%', background: C.sales } })));
				wf.appendChild(h('div', { class: 'v total ' + tone(T.net_profit) }, money(T.net_profit)));

				var fees = h('ul', { class: 'list' }, d.fee_breakdown.slice(0, 12).map(function (f) { return h('li', null, h('span', null, f.type), h('b', { class: tone(f.amount) }, money(f.amount))); }));

				var series = d.series;
				var ch = card('Daily trend', chart({
					labels: series.map(function (r) { return r.date; }),
					series: [
						{ label: 'Sales', values: series.map(function (r) { return r.sales; }), type: 'bar', color: C.sales },
						{ label: 'Net profit', values: series.map(function (r) { return r.net_profit; }), type: 'line', color: C.profit },
						{ label: 'Fees', values: series.map(function (r) { return r.fees; }), type: 'line', color: C.fees },
						{ label: 'Ads', values: series.map(function (r) { return r.ads; }), type: 'line', color: C.ads }
					]
				}), { actions: rangeBar(draw) });

				var skus = table({
					title: 'Profit by product', sub: 'Ad spend is allocated to SKUs by sales share. Click a row to edit its cost.', csv: 'profit-by-sku', sort: 'sales',
					columns: [
						{ key: 'sku', label: 'SKU', render: function (r) { return h('div', null, h('b', null, r.sku), !r.has_cost ? h('span', null, ' ', badge('no cost', 'amber')) : null, h('span', { class: 'title muted small' }, r.title)); } },
						{ key: 'units', label: 'Units', align: 'r', fmt: int, sum: true },
						{ key: 'sales', label: 'Sales', align: 'r', fmt: money, sum: true },
						{ key: 'refunds', label: 'Refunds', align: 'r', fmt: money, sum: true },
						{ key: 'amazon_fees', label: 'Amazon fees', align: 'r', fmt: money, sum: true },
						{ key: 'ads', label: 'Ads (alloc.)', align: 'r', fmt: money, sum: true },
						{ key: 'cogs', label: 'COGS', align: 'r', fmt: money, sum: true },
						{ key: 'net_profit', label: 'Net profit', align: 'r', fmt: money, tone: true, sum: true },
						{ key: 'margin_pct', label: 'Margin', align: 'r', fmt: function (v) { return pct(v); } },
						{ key: 'roi_pct', label: 'ROI', align: 'r', fmt: function (v) { return pct(v); } }
					],
					rows: d.skus,
					onRow: function () { setTab('costs'); }
				});
				return h('div', { class: 'sgs-stack' }, k, ch,
					h('div', { class: 'sgs-grid k2' }, card('Profit waterfall', wf, { sub: shortDate(d.from) + ' – ' + shortDate(d.to) }), card('Fee breakdown', fees, { sub: 'Every Amazon fee type, settled + estimated' })),
					skus);
			});
		}
		function costsView() {
			return api('/costs').then(function (d) {
				var rows = d.rows;
				function inp(r, k, step) {
					return h('input', { type: 'number', step: step || '0.01', min: '0', value: r[k] || '', style: { width: '90px' }, onchange: function (e) { r[k] = e.target.value; r._dirty = true; } });
				}
				var t = table({
					title: 'Product costs (landed COGS)', sub: 'Landed cost = unit + inbound freight + prep + other. Lead time, MOQ and case pack drive the restock planner.', csv: 'product-costs', per: 100, sort: 'sku', dir: 1,
					columns: [
						{ key: 'sku', label: 'SKU', render: function (r) { return h('div', null, h('b', null, r.sku), h('span', { class: 'title muted small' }, r.title)); } },
						{ key: 'unit_cost', label: 'Unit', align: 'r', render: function (r) { return inp(r, 'unit_cost'); } },
						{ key: 'inbound_per_unit', label: 'Inbound/unit', align: 'r', render: function (r) { return inp(r, 'inbound_per_unit'); } },
						{ key: 'prep_per_unit', label: 'Prep/unit', align: 'r', render: function (r) { return inp(r, 'prep_per_unit'); } },
						{ key: 'other_per_unit', label: 'Other/unit', align: 'r', render: function (r) { return inp(r, 'other_per_unit'); } },
						{ key: 'lead_time_days', label: 'Lead days', align: 'r', render: function (r) { return inp(r, 'lead_time_days', '1'); } },
						{ key: 'moq', label: 'MOQ', align: 'r', render: function (r) { return inp(r, 'moq', '1'); } },
						{ key: 'case_pack', label: 'Case pack', align: 'r', render: function (r) { return inp(r, 'case_pack', '1'); } },
						{ key: 'landed', label: 'Landed', align: 'r', fmt: money },
						{ key: 'source', label: 'Source', render: function (r) { return badge(r.source, r.source === 'none' ? 'amber' : 'green'); } }
					],
					rows: rows,
					actions: btn('Save changes', function () {
						var dirty = rows.filter(function (r) { return r._dirty; });
						if (!dirty.length) { toast('No changes'); return Promise.resolve(); }
						return api('/costs', { method: 'POST', body: { rows: dirty } }).then(function (res) { toast(res.saved + ' cost(s) saved', 'ok'); draw(); });
					}, 'primary')
				});
				return t;
			});
		}
		function expensesView() {
			return api('/expenses').then(function (d) {
				var label = h('input', { type: 'text', placeholder: 'e.g. Photography, VA, software' });
				var amount = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0.00' });
				var rec = h('select', null, h('option', { value: 'monthly' }, 'Monthly'), h('option', { value: 'once' }, 'One-off'));
				var start = h('input', { type: 'date', value: ymd(new Date()) });
				var cat = h('select', null, ['software', 'staff', 'marketing', 'samples', 'logistics', 'other'].map(function (c) { return h('option', { value: c }, c); }));
				var form = card('Add expense', h('div', { class: 'form-grid' },
					field('Label', label), field('Amount', amount), field('Recurrence', rec), field('Category', cat), field('Start date', start),
					h('div', { class: 'field' }, h('label', null, ' '), btn('Add expense', function () {
						return api('/expenses', { method: 'POST', body: { label: label.value, amount: amount.value, recurrence: rec.value, start_date: start.value, category: cat.value } }).then(function () { toast('Expense added', 'ok'); draw(); });
					}, 'primary'))), { sub: 'Monthly expenses are pro-rated per day in every P&L range.' });
				var t = table({
					title: 'Expenses', csv: 'expenses', columns: [
						{ key: 'label', label: 'Label' }, { key: 'category', label: 'Category' },
						{ key: 'amount', label: 'Amount', align: 'r', fmt: money }, { key: 'recurrence', label: 'Recurrence' },
						{ key: 'start_date', label: 'Start' }, { key: 'end_date', label: 'End' },
						{ key: 'id', label: '', sort: false, render: function (r) { return btn('Delete', function () { return api('/expenses/' + r.id, { method: 'DELETE' }).then(draw); }, 'sm danger'); } }
					], rows: d.rows, empty: empty('No expenses yet', 'Add software subscriptions, staff, photography, samples…')
				});
				return h('div', { class: 'sgs-stack' }, form, t);
			});
		}
		draw();
		return wrap;
	};

	/* ---------- Orders ---------- */
	PAGES.orders = function () {
		var wrap = h('div', { class: 'sgs-stack' });
		var q = h('input', { type: 'text', placeholder: 'Order ID, SKU or ASIN…' });
		var status = h('select', null, ['', 'Pending', 'Unshipped', 'Shipped', 'Canceled'].map(function (s) { return h('option', { value: s }, s || 'All statuses'); }));
		var slot = h('div');
		function load() {
			clear(slot).appendChild(loading());
			api('/orders', { query: Object.assign(rangeParams(), { q: q.value, status: status.value }) }).then(function (d) {
				clear(slot).appendChild(table({
					title: d.orders.length + ' orders', sub: 'Per-order profit. Fees are settled amounts when available, otherwise estimated from the SKU’s recent fee history.', csv: 'orders', search: false, sort: 'purchase_date',
					columns: [
						{ key: 'purchase_date', label: 'Date', fmt: function (v) { return dateTime(v); } },
						{ key: 'amazon_order_id', label: 'Order', mono: true },
						{ key: 'status', label: 'Status', render: function (r) { return badge(r.status, { Shipped: 'green', Canceled: 'red', Pending: 'amber', Unshipped: 'blue' }[r.status] || ''); } },
						{ key: 'items', label: 'Items', sort: false, csvValue: function (r) { return r.items.map(function (i) { return i.qty + 'x ' + i.sku; }).join('; '); }, render: function (r) { return h('div', { class: 'small' }, r.items.map(function (i) { return h('div', null, i.qty + '× ', h('b', null, i.sku)); })); } },
						{ key: 'units', label: 'Units', align: 'r', fmt: int, sum: true },
						{ key: 'sales', label: 'Sales', align: 'r', fmt: money, sum: true },
						{ key: 'fees', label: 'Fees', align: 'r', sum: true, fmt: money, render: function (r) { return h('span', null, money(r.fees), r.fees_estimated ? h('span', { class: 'muted small', title: 'Estimated — not settled yet' }, ' est.') : null); } },
						{ key: 'refund', label: 'Refund', align: 'r', fmt: money, sum: true },
						{ key: 'cogs', label: 'COGS', align: 'r', fmt: money, sum: true },
						{ key: 'profit', label: 'Profit', align: 'r', fmt: money, tone: true, sum: true },
						{ key: 'fulfillment_channel', label: 'Ch.', fmt: function (v) { return v === 'AFN' ? 'FBA' : 'FBM'; } }
					],
					rows: d.orders, empty: empty('No orders in this range', state.connected ? 'Orders sync every 15 minutes.' : 'Connect Amazon or load the demo account.')
				}));
			}, function (e) { clear(slot).appendChild(failure(e)); });
		}
		wrap.appendChild(pageHead('Orders', 'Every order with its own profit — near real time from the Orders API, backfilled from the all-orders report.', [q, status, btn('Search', load, 'primary sm'), rangeBar(load)]));
		wrap.appendChild(slot);
		q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { load(); } });
		load();
		return wrap;
	};

	/* ---------- Restock ---------- */
	var STATUS = {
		out_of_stock: ['Out of stock', 'red'], critical: ['Critical', 'red'], stockout_risk: ['Gap before inbound', 'red'], reorder_now: ['Reorder now', 'amber'],
		reorder_soon: ['Reorder soon', 'blue'], healthy: ['Healthy', 'green'], overstock: ['Overstock', 'violet'], no_sales: ['No sales', '']
	};
	PAGES.restock = function () {
		return Promise.all([api('/restock'), api('/inventory-health')]).then(function (res) {
			var d = res[0], ih = res[1], S = d.summary;
			var k = h('div', { class: 'sgs-grid k5' },
				kpi('SKUs tracked', int(S.skus)),
				kpi('Need reorder', int(S.reorder), 'critical + reorder now', S.reorder ? 'tone-amber' : ''),
				kpi('Out of stock', int(S.out_of_stock), S.lost_sales_per_day > 0 ? '≈' + money(S.lost_sales_per_day) + '/day lost' : 'none losing sales', S.out_of_stock ? 'tone-red' : 'tone-green'),
				kpi('Suggested PO', int(S.order_units) + ' units', money(S.order_value) + ' at landed cost'),
				kpi('Overstock', int(S.overstock), '> overstock threshold days of cover'));
			var t = table({
				title: 'Restock planner', sub: 'Sorted by urgency. Velocity blends 7/30/90-day sales (stock-out days excluded). Order qty covers lead time + target cover, rounded to case pack and MOQ.', csv: 'restock-plan', per: 100,
				columns: [
					{ key: 'status', label: 'Status', render: function (r) { var s = STATUS[r.status] || [r.status, '']; return badge(s[0], s[1]); }, csvValue: function (r) { return r.status; } },
					{ key: 'sku', label: 'SKU', render: function (r) { return h('div', null, h('b', null, r.sku), h('span', { class: 'title muted small' }, r.title)); } },
					{ key: 'fulfillable', label: 'Available', align: 'r', fmt: int },
					{ key: 'inbound', label: 'Inbound', align: 'r', fmt: int },
					{ key: 'velocity', label: 'Units/day', align: 'r', fmt: function (v) { return num(v).toFixed(1); } },
					{ key: 'trend_pct', label: '7d vs 30d', align: 'r', render: function (r) { return r.trend_pct === null ? '—' : h('span', { class: tone(r.trend_pct) }, signed(r.trend_pct, function (v) { return pct(v, 0); })); } },
					{ key: 'days_of_cover', label: 'Days of cover', align: 'r', render: function (r) { return r.days_of_cover === null ? '—' : h('div', null, int(r.days_of_cover), meter(r.days_of_cover / 1.2, r.days_of_cover < r.lead_time ? 'red' : (r.days_of_cover < r.lead_time + 30 ? 'amber' : 'green'))); } },
					{ key: 'stockout_date', label: 'Stock-out', fmt: shortDate },
					{ key: 'reorder_by', label: 'Order by', render: function (r) { return r.reorder_by ? h('span', { class: r.reorder_by <= ymd(new Date()) ? 'neg' : '' }, shortDate(r.reorder_by)) : '—'; } },
					{ key: 'lead_time', label: 'Lead', align: 'r', fmt: function (v) { return v + 'd'; } },
					{ key: 'order_qty', label: 'Order qty', align: 'r', render: function (r) { return r.order_qty ? h('b', null, int(r.order_qty)) : '—'; }, sum: true, fmt: int },
					{ key: 'order_value', label: 'PO value', align: 'r', fmt: money, sum: true }
				],
				rows: d.rows, empty: empty('No inventory yet', 'Run a product sync from Seven Gum → Products, or load the demo account.')
			});
			var aged = table({
				title: 'Inventory age & storage (FBA inventory planning report)', sub: ih.snapshot ? 'Snapshot ' + ih.snapshot : 'Requested daily via the Reports API.', csv: 'inventory-age',
				columns: [
					{ key: 'sku', label: 'SKU' }, { key: 'available', label: 'Available', align: 'r', fmt: int },
					{ key: 'age_0_90', label: '0–90d', align: 'r', fmt: int }, { key: 'age_91_180', label: '91–180d', align: 'r', fmt: int },
					{ key: 'age_181_270', label: '181–270d', align: 'r', fmt: int }, { key: 'age_271_365', label: '271–365d', align: 'r', fmt: int },
					{ key: 'age_365_plus', label: '365d+', align: 'r', fmt: int },
					{ key: 'days_of_supply', label: 'Days supply', align: 'r', fmt: int },
					{ key: 'est_storage_cost', label: 'Storage next mo.', align: 'r', fmt: money, sum: true },
					{ key: 'recommended_action', label: 'Amazon recommends' }
				], rows: ih.rows
			});
			return h('div', { class: 'sgs-stack' }, pageHead('Inventory & Restock', 'Never stock out, never over-pay storage: demand forecasting, reorder dates, PO quantities and aged-inventory risk.', [h('a', { class: 'btn sm', href: '#/profit?tab=costs' }, 'Edit lead times & case packs')]), k, t, aged);
		});
	};

	/* ---------- PPC ---------- */
	PAGES.ppc = function () {
		var tab = (window.location.hash.split('tab=')[1] || 'optimizer');
		var wrap = h('div', { class: 'sgs-stack' });
		var body = h('div', { class: 'sgs-stack' });
		function setTab(t) { tab = t; history.replaceState(null, '', '#/ppc?tab=' + t); draw(); }
		function draw() {
			clear(wrap);
			clear(body).appendChild(loading());
			wrap.appendChild(pageHead('PPC Manager', 'Sponsored Products automation: rule-based bid optimisation to your target ACoS, search-term harvesting, negative keywords and budget pacing — always reviewable before it touches Amazon.', [rangeBar(draw)]));
			api('/ads/overview', { query: rangeParams() }).then(function (o) {
				var T = o.totals;
				var k = h('div', { class: 'sgs-grid k5' },
					kpi('Spend', money(T.cost), int(T.clicks) + ' clicks · CPC ' + money(T.cpc)),
					kpi('Ad sales', money(T.sales), int(T.orders) + ' orders · CVR ' + pct(T.cvr)),
					kpi('ACoS', pct(T.acos), 'ROAS ' + (T.roas || '—'), num(T.acos) > 40 ? 'tone-red' : 'tone-green'),
					kpi('CTR', pct(T.ctr, 2), int(T.impressions) + ' impressions'),
					kpi('Wasted spend', money(T.wasted_spend), 'search terms with 0 orders', T.wasted_spend > 0 ? 'tone-amber' : ''));
				var ch = card('Spend vs ad sales', chart({
					labels: o.series.map(function (r) { return r.date; }),
					series: [
						{ label: 'Ad sales', values: o.series.map(function (r) { return r.sales; }), type: 'bar', color: C.sales },
						{ label: 'Spend', values: o.series.map(function (r) { return r.cost; }), type: 'bar', color: C.ads },
						{ label: 'ACoS', values: o.series.map(function (r) { return r.acos; }), type: 'line', color: C.refunds, axis: 'right', fmt: function (v) { return pct(v); } }
					], height: 220
				}));
				var info = !o.ready && !state.demo ? h('div', { class: 'sgs-banner info' }, h('span', null, h('b', null, 'Amazon Ads API not connected. '), 'Add your Ads API credentials and pick a profile in Settings to sync campaigns and apply changes.'), h('a', { class: 'btn sm', href: '#/settings' }, 'Connect Ads API')) : null;
				clear(wrap);
				wrap.appendChild(pageHead('PPC Manager', 'Sponsored Products automation: rule-based bid optimisation to your target ACoS, search-term harvesting, negative keywords and budget pacing — always reviewable before it touches Amazon.', [rangeBar(draw)]));
				add(wrap, [info, k, ch, h('div', null, seg([['optimizer', 'Optimizer' + (o.planned ? ' (' + o.planned + ')' : '')], ['campaigns', 'Campaigns'], ['targets', 'Keywords & targets'], ['terms', 'Search terms'], ['history', 'Change log']], tab, setTab)), body]);
				var view = { optimizer: optimizer, campaigns: campaigns, targets: targets, terms: terms, history: historyView }[tab] || optimizer;
				view().then(function (n) { clear(body).appendChild(n); }, function (e) { clear(body).appendChild(failure(e)); });
			}, function (e) { clear(wrap).appendChild(failure(e)); });
		}
		function kcols() {
			return [
				{ key: 'impressions', label: 'Impr.', align: 'r', fmt: int, sum: true },
				{ key: 'clicks', label: 'Clicks', align: 'r', fmt: int, sum: true },
				{ key: 'ctr', label: 'CTR', align: 'r', fmt: function (v) { return pct(v, 2); } },
				{ key: 'cpc', label: 'CPC', align: 'r', fmt: money },
				{ key: 'cost', label: 'Spend', align: 'r', fmt: money, sum: true },
				{ key: 'sales', label: 'Sales', align: 'r', fmt: money, sum: true },
				{ key: 'orders', label: 'Orders', align: 'r', fmt: int, sum: true },
				{ key: 'cvr', label: 'CVR', align: 'r', fmt: function (v) { return pct(v); } },
				{ key: 'acos', label: 'ACoS', align: 'r', render: function (r) { return r.acos === null ? '—' : h('span', { class: num(r.acos) > 40 ? 'neg' : (num(r.acos) < 25 ? 'pos' : '') }, pct(r.acos)); } }
			];
		}
		function optimizer() {
			return api('/ads/actions').then(function (d) {
				var KIND = { bid: ['Bid', 'blue'], pause: ['Pause', 'red'], negative: ['Negative', 'red'], harvest: ['Harvest → exact', 'green'], harvest_asin: ['Harvest ASIN', 'green'], budget: ['Budget', 'violet'] };
				var t = table({
					title: d.planned.length + ' recommended changes', sub: 'Nothing is pushed until you apply it. Bids move toward (revenue per click × target ACoS) and never jump more than the max step.', csv: 'ppc-plan', selectable: 'id', sort: 'kind', dir: 1, per: 100,
					bulk: function (getSel) {
						return h('div', { class: 'btns' },
							btn('Apply selected', function () { var ids = getSel().map(function (r) { return r.id; }); if (!ids.length) { toast('Select rows first'); return Promise.resolve(); } return api('/ads/apply', { method: 'POST', body: { ids: ids } }).then(function (r) { toast(r.applied + ' applied' + (r.failed ? ', ' + r.failed + ' failed' : ''), r.failed ? 'bad' : 'ok'); draw(); }); }, 'green sm'),
							btn('Dismiss selected', function () { var ids = getSel().map(function (r) { return r.id; }); if (!ids.length) { return Promise.resolve(); } return api('/ads/dismiss', { method: 'POST', body: { ids: ids } }).then(function () { draw(); }); }, 'sm'));
					},
					columns: [
						{ key: 'kind', label: 'Action', render: function (r) { var k = KIND[r.kind] || [r.kind, '']; return badge(k[0], k[1]); } },
						{ key: 'label', label: 'Keyword / target / campaign', render: function (r) { return h('b', null, r.label); } },
						{ key: 'old_value', label: 'Now', align: 'r' },
						{ key: 'new_value', label: 'Proposed', align: 'r', render: function (r) { var up = num(r.new_value) > num(r.old_value); return h('b', { class: r.kind === 'bid' || r.kind === 'budget' ? (up ? 'pos' : 'neg') : '' }, r.new_value); } },
						{ key: 'reason', label: 'Why', render: function (r) { return h('span', { class: 'small muted' }, r.reason); } }
					],
					rows: d.planned,
					actions: btn('Re-run optimizer', function () { return api('/ads/optimize', { method: 'POST' }).then(function (r) { toast(r.bids + ' bid, ' + r.terms + ' search-term and ' + r.budgets + ' budget changes planned', 'ok'); draw(); }); }, 'primary'),
					empty: empty('No changes recommended', 'Run the optimizer after your ads data syncs (daily).')
				});
				return t;
			});
		}
		function campaigns() {
			return api('/ads/campaigns', { query: rangeParams() }).then(function (d) {
				return table({ title: 'Campaigns', csv: 'campaigns', sort: 'cost', columns: [
					{ key: 'name', label: 'Campaign', render: function (r) { return h('div', null, h('b', null, r.name), h('div', { class: 'small muted' }, r.targeting_type + ' · ' + (r.bidding_strategy || '').replace(/_/g, ' ').toLowerCase())); } },
					{ key: 'state', label: 'State', render: function (r) { return badge(r.state, r.state === 'ENABLED' ? 'green' : ''); } },
					{ key: 'daily_budget', label: 'Budget/day', align: 'r', fmt: money }
				].concat(kcols()), rows: d.rows, onRow: function (r) { targetsDrawer(r); } });
			});
		}
		function targetsDrawer(c) {
			var dr = drawer(c.name, loading());
			api('/ads/targets', { query: Object.assign(rangeParams(), { campaign: c.campaign_id }) }).then(function (d) {
				clear(dr.body).appendChild(table({ title: 'Keywords & targets', search: false, sort: 'cost', columns: [
					{ key: 'keyword_text', label: 'Keyword / target', render: function (r) { return h('div', null, h('b', null, r.keyword_text), ' ', badge(r.match_type)); } },
					{ key: 'bid', label: 'Bid', align: 'r', fmt: money }
				].concat(kcols()), rows: d.rows }));
			});
		}
		function targets() {
			return api('/ads/targets', { query: rangeParams() }).then(function (d) {
				return table({ title: 'Keywords & product targets', csv: 'ppc-targets', sort: 'cost', columns: [
					{ key: 'keyword_text', label: 'Keyword / target', render: function (r) { return h('div', null, h('b', null, r.keyword_text), ' ', badge(r.match_type), h('div', { class: 'small muted' }, r.campaign)); } },
					{ key: 'state', label: 'State', render: function (r) { return badge(r.state, r.state === 'ENABLED' ? 'green' : ''); } },
					{ key: 'bid', label: 'Bid', align: 'r', fmt: money }
				].concat(kcols()), rows: d.rows });
			});
		}
		function terms() {
			return api('/ads/search-terms', { query: rangeParams() }).then(function (d) {
				return table({ title: 'Customer search terms', sub: 'What shoppers actually typed. Zero-order terms with many clicks are negative candidates; converting terms are harvest candidates.', csv: 'search-terms', sort: 'cost', columns: [
					{ key: 'search_term', label: 'Search term', render: function (r) { return h('div', null, h('b', null, r.search_term), h('div', { class: 'small muted' }, 'via ' + r.keyword_text + ' (' + r.match_type + ')')); } }
				].concat(kcols()), rows: d.rows });
			});
		}
		function historyView() {
			return api('/ads/actions').then(function (d) {
				return table({ title: 'Change log', csv: 'ppc-change-log', sort: 'applied_at', columns: [
					{ key: 'applied_at', label: 'When', fmt: function (v, r) { return dateTime(v || r.created_at); } },
					{ key: 'kind', label: 'Action' }, { key: 'label', label: 'Entity' },
					{ key: 'old_value', label: 'From', align: 'r' }, { key: 'new_value', label: 'To', align: 'r' },
					{ key: 'status', label: 'Status', render: function (r) { return badge(r.status, { applied: 'green', failed: 'red', dismissed: '' }[r.status]); } },
					{ key: 'error', label: 'Error', render: function (r) { return h('span', { class: 'small neg' }, r.error || ''); } }
				], rows: d.history });
			});
		}
		draw();
		return wrap;
	};

	/* ---------- Keywords ---------- */
	PAGES.keywords = function () {
		return api('/keywords').then(function (d) {
			var asinSel = h('select', null, d.asins.map(function (a) { return h('option', { value: a }, a); }));
			var kwInput = h('textarea', { placeholder: 'One keyword per line', rows: 3 });
			var prio = h('select', null, h('option', { value: 1 }, 'High'), h('option', { value: 2, selected: true }, 'Medium'), h('option', { value: 3 }, 'Low'));
			var addCard = card('Track keywords', h('div', { class: 'form-grid' },
				field('ASIN', asinSel), field('Priority', prio), h('div', { class: 'field', style: { gridColumn: 'span 2' } }, h('label', null, 'Keywords'), kwInput),
				h('div', { class: 'field' }, h('label', null, ' '), btn('Add', function () {
					return api('/keywords', { method: 'POST', body: { asin: asinSel.value, keywords: kwInput.value, priority: prio.value } }).then(function (r) { toast(r.added + ' keyword(s) tracked', 'ok'); route(); });
				}, 'primary'))), { sub: 'Share of search comes from Brand Analytics Search Query Performance (weekly, brand-registered sellers).' });

			var tracked = table({
				title: 'Tracked keywords — share of search', sub: d.rows[0] && d.rows[0].week ? 'Week of ' + shortDate(d.rows[0].week) : 'Waiting for the first weekly SQP report.', csv: 'tracked-keywords', sort: 'volume',
				columns: [
					{ key: 'keyword', label: 'Keyword', render: function (r) { return h('div', null, h('b', null, r.keyword), ' ', badge(['', 'High', 'Med', 'Low'][r.priority] || '', r.priority == 1 ? 'dark' : '')); } },
					{ key: 'asin', label: 'ASIN', mono: true, render: function (r) { return h('a', { href: amazonUrl(r.asin), target: '_blank', rel: 'noopener' }, r.asin); } },
					{ key: 'volume', label: 'Search volume / wk', align: 'r', fmt: int },
					{ key: 'impr_share', label: 'Impr. share', align: 'r', fmt: function (v) { return pct(v, 2); } },
					{ key: 'click_share', label: 'Click share', align: 'r', fmt: function (v) { return pct(v, 2); } },
					{ key: 'purchase_share', label: 'Purchase share', align: 'r', render: function (r) { return h('span', null, pct(r.purchase_share, 2), r.purchase_share_prev !== null ? delta(r.purchase_share, r.purchase_share_prev) : null); } },
					{ key: 'ctr', label: 'CTR', align: 'r', fmt: function (v) { return pct(v, 2); } },
					{ key: 'cvr', label: 'CVR', align: 'r', fmt: function (v) { return pct(v, 1); } },
					{ key: 'trend', label: '8-wk impr. share', sort: false, csv: false, render: function (r) { return r.trend && r.trend.length ? sparkline(r.trend, C.sales) : '—'; } },
					{ key: 'id', label: '', sort: false, csv: false, render: function (r) { return btn('×', function () { return api('/keywords/' + r.id, { method: 'DELETE' }).then(route); }, 'sm ghost', { title: 'Stop tracking' }); } }
				], rows: d.rows, empty: empty('No keywords tracked', 'Add keywords above or discover them below.')
			});

			var resAsin = h('input', { type: 'text', placeholder: 'ASIN(s), comma separated', value: d.asins.slice(0, 3).join(', ') });
			var resSlot = h('div');
			var research = card('Keyword research', h('div', { class: 'sgs-stack' },
				h('div', { class: 'btns' }, resAsin, btn('Find keywords', function () {
					clear(resSlot).appendChild(loading());
					return api('/keywords/research', { method: 'POST', body: { asins: resAsin.value.split(/[\s,]+/).filter(Boolean) } }).then(function (r) {
						clear(resSlot).appendChild(table({ search: true, csv: 'keyword-ideas', sort: 'orders', columns: [
							{ key: 'keyword', label: 'Keyword', render: function (k) { return h('b', null, k.keyword); } },
							{ key: 'source', label: 'Source', render: function (k) { return badge({ amazon_ads: 'Amazon Ads', your_ads: 'Your search terms', both: 'Both' }[k.source] || k.source, k.source === 'both' ? 'green' : 'blue'); } },
							{ key: 'suggested_bid', label: 'Suggested bid', align: 'r', fmt: money },
							{ key: 'impression_rank', label: 'Impr. rank', align: 'r' },
							{ key: 'orders', label: 'Your orders', align: 'r', fmt: int },
							{ key: 'acos', label: 'Your ACoS', align: 'r', fmt: function (v) { return pct(v); } },
							{ key: 'keyword', label: '', sort: false, csv: false, render: function (k) { return btn('Track', function () { return api('/keywords', { method: 'POST', body: { asin: (resAsin.value.split(/[\s,]+/)[0] || asinSel.value), keywords: [k.keyword] } }).then(function () { toast('Tracking “' + k.keyword + '”', 'ok'); }); }, 'sm'); } }
						], rows: r.rows, empty: empty('No ideas yet', 'Connect the Ads API for Amazon keyword recommendations; converting search terms appear once ads data syncs.') }));
					});
				}, 'primary')), resSlot), { sub: 'Amazon Ads keyword recommendations for your ASINs + search terms that already convert in your campaigns.' });

			var qAsin = h('select', null, d.asins.map(function (a) { return h('option', { value: a }, a); }));
			var qSlot = h('div');
			var sqp = card('All search queries for an ASIN (Brand Analytics)', h('div', { class: 'sgs-stack' }, h('div', { class: 'btns' }, qAsin, btn('Load', function () {
				return api('/keywords/queries', { query: { asin: qAsin.value } }).then(function (r) {
					clear(qSlot).appendChild(table({ search: true, csv: 'sqp-queries', sort: 'query_volume', columns: [
						{ key: 'keyword', label: 'Query', render: function (k) { return h('b', null, k.keyword); } },
						{ key: 'query_volume', label: 'Volume', align: 'r', fmt: int },
						{ key: 'impr_share', label: 'Impr. share', align: 'r', fmt: function (v) { return pct(v, 2); } },
						{ key: 'click_share', label: 'Click share', align: 'r', fmt: function (v) { return pct(v, 2); } },
						{ key: 'purchase_share', label: 'Purchase share', align: 'r', fmt: function (v) { return pct(v, 2); } },
						{ key: 'purchases_asin', label: 'Your purchases', align: 'r', fmt: int }
					], rows: r.rows }));
				});
			}, 'sm')), qSlot));

			return h('div', { class: 'sgs-stack' }, pageHead('Keywords', 'Track share of search per keyword, discover new keywords and see every query shoppers use to find your ASINs.'), addCard, tracked, research, sqp);
		});
	};

	/* ---------- Listings ---------- */
	PAGES.listings = function () {
		return api('/listings').then(function (d) {
			var avg = d.rows.length ? Math.round(d.rows.reduce(function (a, r) { return a + num(r.score); }, 0) / d.rows.length) : null;
			var sup = d.rows.filter(function (r) { return r.status === 'suppressed'; }).length;
			var k = h('div', { class: 'sgs-grid k4' },
				kpi('Average listing score', avg === null ? '—' : avg + '/100', d.rows.length + ' listings audited', avg !== null && avg < 75 ? 'tone-amber' : 'tone-green'),
				kpi('Suppressed / inactive', int(sup), 'not buyable right now', sup ? 'tone-red' : 'tone-green'),
				kpi('Errors to fix', int(d.rows.reduce(function (a, r) { return a + r.findings.filter(function (f) { return f.severity === 'error'; }).length; }, 0)), 'policy & suppression risks'),
				kpi('Below grade B', int(d.rows.filter(function (r) { return r.score < 80; }).length), 'conversion upside'));
			var warn = !d.seller_id_set && !state.demo ? h('div', { class: 'sgs-banner warn' }, h('span', null, h('b', null, 'Seller ID needed. '), 'Listing audits read your listings through the Listings Items API, which needs your Merchant Token.'), h('a', { class: 'btn sm', href: '#/settings' }, 'Add Seller ID')) : null;
			var t = table({
				title: 'Listing quality', sub: 'Title, bullets, description, backend keywords, images, Amazon issues and tracked-keyword coverage. Click a row for the full audit and an AI rewrite.', csv: 'listing-audit', sort: 'score', dir: 1,
				columns: [
					{ key: 'score', label: 'Score', render: function (r) { var g = r.score >= 90 ? 'A' : r.score >= 80 ? 'B' : r.score >= 65 ? 'C' : r.score >= 50 ? 'D' : 'F'; return h('div', { class: 'btns' }, h('span', { class: 'grade ' + g }, g), h('b', null, r.score)); } },
					{ key: 'sku', label: 'SKU', render: function (r) { return h('div', null, h('b', null, r.sku), h('span', { class: 'title muted small' }, (r.snapshot && r.snapshot.title) || '')); } },
					{ key: 'status', label: 'Status', render: function (r) { return badge(r.status, r.status === 'active' ? 'green' : (r.status === 'suppressed' ? 'red' : '')); } },
					{ key: 'errors', label: 'Errors', align: 'r', render: function (r) { var n = r.findings.filter(function (f) { return f.severity === 'error'; }).length; return n ? h('b', { class: 'neg' }, n) : '0'; } },
					{ key: 'warnings', label: 'Warnings', align: 'r', render: function (r) { return String(r.findings.filter(function (f) { return f.severity === 'warning'; }).length); } },
					{ key: 'audited_at', label: 'Audited', fmt: function (v) { return dateTime(v); } }
				],
				rows: d.rows, onRow: listingDrawer,
				actions: btn('Audit all listings', function () { return api('/listings/audit', { method: 'POST', body: {} }).then(function (r) { toast(r.audited + ' listing(s) audited', 'ok'); route(); }); }, 'primary'),
				empty: empty('No audits yet', 'Click “Audit all listings”.')
			});
			return h('div', { class: 'sgs-stack' }, pageHead('Listing Optimizer', 'Grade every listing against Amazon’s style guide and the 2025 title policy, catch suppressions, and rewrite copy with AI in your brand voice.'), warn, k, t);
		});
	};

	function findingsList(findings) {
		var SEV = { error: ['Error', 'red'], warning: ['Warning', 'amber'], info: ['Tip', 'blue'] };
		return h('div', null, findings.length ? findings.map(function (f) { var s = SEV[f.severity] || [f.severity, '']; return h('div', { class: 'finding' }, badge(s[0], s[1]), h('span', { class: 'muted small', style: { minWidth: '80px' } }, f.section), h('span', null, f.message)); }) : empty('Perfect', 'No findings.'));
	}

	function listingDrawer(r) {
		var c = r.snapshot || {};
		var aiSlot = h('div');
		var content = h('div', { class: 'sgs-stack' },
			h('div', { class: 'sgs-grid k3' }, kpi('Score', r.score + '/100'), kpi('Status', r.status), kpi('Images', (c.images || []).length)),
			card('Findings', findingsList(r.findings)),
			card('Current content', h('dl', { class: 'kv' },
				h('dt', null, 'Title (' + (c.title || '').length + ' chars)'), h('dd', null, c.title || '—'),
				h('dt', null, 'Bullets'), h('dd', null, (c.bullets || []).length ? h('ol', { style: { margin: 0, paddingLeft: '18px' } }, (c.bullets || []).map(function (b) { return h('li', null, b); })) : '—'),
				h('dt', null, 'Backend terms'), h('dd', null, c.backend || '—'),
				h('dt', null, 'Description'), h('dd', { class: 'small' }, (c.description || '—').slice(0, 600)))),
			card('AI rewrite', aiSlot, { sub: 'Uses your AI provider (Seven Gum → AI) with your tracked keywords. Review before publishing — nothing is pushed automatically.' }));
		aiSlot.appendChild(btn('Generate optimized copy', function () {
			clear(aiSlot).appendChild(loading());
			return api('/listings/ai', { method: 'POST', body: { sku: r.sku } }).then(function (x) {
				var dft = x.draft;
				var text = 'TITLE:\n' + dft.title + '\n\nBULLETS:\n- ' + dft.bullets.join('\n- ') + '\n\nBACKEND SEARCH TERMS:\n' + dft.backend;
				clear(aiSlot).appendChild(h('div', { class: 'sgs-stack' },
					h('div', { class: 'btns' }, badge('New score ' + x.score.score + '/100', x.score.score >= r.score ? 'green' : 'amber'), h('span', { class: 'muted small' }, x.provider + ' · ' + x.model), btn('Copy', function () { return copy(text); }, 'sm')),
					h('div', { class: 'pre' }, text), findingsList(x.score.findings)));
			}, function (e) { clear(aiSlot).appendChild(failure(e)); });
		}, 'primary'));
		drawer(r.sku, content, [
			r.asin ? h('a', { class: 'btn sm', href: amazonUrl(r.asin), target: '_blank', rel: 'noopener' }, 'View on Amazon') : null,
			btn('Re-audit', function () { return api('/listings/audit', { method: 'POST', body: { sku: r.sku } }).then(function () { toast('Audited', 'ok'); route(); }); }, 'sm')
		]);
	}

	/* ---------- Monitor ---------- */
	PAGES.monitor = function () {
		return api('/monitor').then(function (d) {
			var mine = d.rows.filter(function (r) { return +r.is_mine; });
			var won = mine.filter(function (r) { return +r.buybox_is_mine; }).length;
			var k = h('div', { class: 'sgs-grid k4' },
				kpi('Buy Box share', mine.length ? pct(won / mine.length * 100) : '—', won + ' of ' + mine.length + ' ASINs', won === mine.length ? 'tone-green' : 'tone-amber'),
				kpi('Hijackers / other sellers', int(d.hijacks.length), 'on your listings right now', d.hijacks.length ? 'tone-red' : 'tone-green'),
				kpi('ASINs watched', int(d.watching), 'yours + competitors'),
				kpi('Competitors', int(d.rows.length - mine.length), 'add more in Settings'));
			var hij = d.hijacks.length ? table({ title: '⚠️ Sellers on your listings', search: false, columns: [
				{ key: 'asin', label: 'ASIN', mono: true, render: function (r) { return h('a', { href: amazonUrl(r.asin), target: '_blank', rel: 'noopener' }, r.asin); } },
				{ key: 'seller_id', label: 'Seller', mono: true, render: function (r) { return h('a', { href: 'https://www.amazon.' + marketInfo().tld + '/sp?seller=' + encodeURIComponent(r.seller_id), target: '_blank', rel: 'noopener' }, r.seller_id); } },
				{ key: 'is_fba', label: 'Fulfilment', render: function (r) { return +r.is_fba ? 'FBA' : 'FBM'; } },
				{ key: 'last_price', label: 'Price', align: 'r', fmt: money },
				{ key: 'first_seen', label: 'First seen', fmt: function (v) { return dateTime(v); } }
			], rows: d.hijacks }) : null;
			var t = table({
				title: 'Listing watch', sub: 'Buy Box owner, price, offers and BSR from the Product Pricing API every 15 minutes (rotating batches). Click for price/BSR history.', csv: 'listing-watch', sort: 'is_mine',
				columns: [
					{ key: 'asin', label: 'ASIN', mono: true, render: function (r) { return h('div', null, h('b', null, r.asin), ' ', +r.is_mine ? badge('yours', 'dark') : badge('competitor')); } },
					{ key: 'buybox_is_mine', label: 'Buy Box', render: function (r) { return +r.is_mine ? (+r.buybox_is_mine ? badge('Winning', 'green') : badge(r.buybox_seller ? 'Lost' : 'Suppressed', 'red')) : (r.buybox_seller || '—'); } },
					{ key: 'buybox_price', label: 'Buy Box price', align: 'r', fmt: money },
					{ key: 'my_price', label: 'Your price', align: 'r', fmt: money },
					{ key: 'lowest_price', label: 'Lowest', align: 'r', fmt: money },
					{ key: 'offer_count', label: 'Offers', align: 'r', fmt: int },
					{ key: 'other_sellers', label: 'Other sellers', align: 'r', render: function (r) { return +r.is_mine && +r.other_sellers ? h('b', { class: 'neg' }, r.other_sellers) : String(r.other_sellers || 0); } },
					{ key: 'bsr', label: 'BSR', align: 'r', fmt: int },
					{ key: 'captured_at', label: 'Checked', fmt: function (v) { return dateTime(v); } }
				],
				rows: d.rows, onRow: monitorDrawer,
				actions: btn('Check now', function () { return api('/monitor/run', { method: 'POST' }).then(function (r) { toast(r.checked + ' ASIN(s) checked, ' + r.alerts + ' alert(s)', 'ok'); route(); }); }, 'primary'),
				empty: empty('Nothing watched yet', 'Your ASINs appear after the first product sync.')
			});
			return h('div', { class: 'sgs-stack' }, pageHead('Hijackers & Buy Box', 'Instant alerts when a new seller jumps on your listing, when you lose the Buy Box, or when a competitor slashes price — with Keepa-style history.'), k, hij, t);
		});
	}

	function monitorDrawer(r) {
		var dr = drawer(r.asin + (+r.is_mine ? ' (yours)' : ''), loading(), [h('a', { class: 'btn sm', href: amazonUrl(r.asin), target: '_blank', rel: 'noopener' }, 'View on Amazon')]);
		api('/monitor/history', { query: { asin: r.asin, days: 90 } }).then(function (d) {
			var hst = d.history;
			clear(dr.body).appendChild(h('div', { class: 'sgs-stack' },
				card('Price history', chart({ labels: hst.map(function (x) { return x.captured_at; }), series: [
					{ label: 'Buy Box', values: hst.map(function (x) { return x.buybox_price; }), type: 'line', color: C.sales },
					{ label: 'Lowest', values: hst.map(function (x) { return x.lowest_price; }), type: 'line', color: C.refunds },
					{ label: 'Your price', values: hst.map(function (x) { return x.my_price; }), type: 'line', color: C.profit }
				], height: 200, fmt: money })),
				card('Best Sellers Rank', chart({ labels: hst.map(function (x) { return x.captured_at; }), series: [
					{ label: 'BSR (lower is better)', values: hst.map(function (x) { return x.bsr; }), type: 'area', color: C.units, fmt: int }
				], height: 170, fmt: int })),
				table({ title: 'Sellers seen on this listing', search: false, columns: [
					{ key: 'seller_id', label: 'Seller', mono: true, render: function (x) { return h('span', null, x.seller_id, ' ', +x.is_me ? badge('you', 'dark') : null); } },
					{ key: 'is_fba', label: 'FBA', render: function (x) { return +x.is_fba ? 'FBA' : 'FBM'; } },
					{ key: 'last_price', label: 'Price', align: 'r', fmt: money },
					{ key: 'active', label: 'Active', render: function (x) { return +x.active ? badge('active', 'green') : badge('gone'); } },
					{ key: 'first_seen', label: 'First seen', fmt: function (v) { return dateTime(v); } },
					{ key: 'last_seen', label: 'Last seen', fmt: function (v) { return dateTime(v); } }
				], rows: d.sellers })));
		}, function (e) { clear(dr.body).appendChild(failure(e)); });
	}

	/* ---------- Reviews ---------- */
	PAGES.reviews = function () {
		return Promise.all([api('/reviews'), api('/feedback')]).then(function (res) {
			var d = res[0], fb = res[1];
			var off = !d.enabled ? h('div', { class: 'sgs-banner info' }, h('span', null, h('b', null, 'Automatic review requests are off. '), 'Turn them on in Settings — the suite then sends Amazon’s own “Request a Review” for every eligible order (5–30 days after delivery), skipping refunded and returned orders.'), h('a', { class: 'btn sm', href: '#/settings' }, 'Enable')) : null;
			var k = h('div', { class: 'sgs-grid k4' },
				kpi('Requests sent (30d)', int(d.by_status.sent), 'via Solicitations API', 'tone-green'),
				kpi('Waiting for window', int(d.pending), 'eligible orders queued'),
				kpi('Ineligible', int(d.by_status.ineligible), 'outside window / already requested'),
				kpi('Seller feedback', fb.avg === null ? '—' : fb.avg + '★', fb.count + ' ratings · ' + pct(fb.negative_pct) + ' negative', num(fb.negative_pct) > 5 ? 'tone-red' : ''));
			var ch = card('Requests sent per day', chart({ labels: d.daily.map(function (x) { return x.d; }), series: [{ label: 'Sent', values: d.daily.map(function (x) { return x.sent; }), type: 'bar', color: C.units, fmt: int }], height: 180, fmt: int }));
			var t = table({ title: 'Recent requests', csv: 'review-requests', sort: 'attempted_at', columns: [
				{ key: 'attempted_at', label: 'When', fmt: function (v) { return dateTime(v); } },
				{ key: 'amazon_order_id', label: 'Order', mono: true },
				{ key: 'status', label: 'Result', render: function (r) { return badge(r.status, { sent: 'green', ineligible: '', error: 'red' }[r.status]); } },
				{ key: 'message', label: 'Note', render: function (r) { return h('span', { class: 'small muted' }, r.message); } }
			], rows: d.recent, actions: btn('Send eligible now', function () { return api('/reviews/run', { method: 'POST' }).then(function (r) { toast(r.sent + ' sent, ' + r.ineligible + ' ineligible', 'ok'); route(); }); }, 'primary') });
			var f = table({ title: 'Seller feedback', csv: 'seller-feedback', sort: 'feedback_date', columns: [
				{ key: 'feedback_date', label: 'Date', fmt: shortDate },
				{ key: 'rating', label: 'Rating', render: function (r) { return h('span', { class: +r.rating <= 2 ? 'neg' : '' }, '★'.repeat(+r.rating) + '☆'.repeat(5 - +r.rating)); } },
				{ key: 'comments', label: 'Comment' }, { key: 'amazon_order_id', label: 'Order', mono: true }
			], rows: fb.rows });
			return h('div', { class: 'sgs-stack' }, pageHead('Review Requests', 'Fully Amazon-compliant review automation — the same request as the Seller Central button, sent at the best moment for every order.'), off, k, ch, t, f);
		});
	};

	/* ---------- Reimbursements ---------- */
	PAGES.reimbursements = function () {
		var status = (window.location.hash.split('status=')[1] || 'open');
		return api('/reimbursements', { query: { status: status } }).then(function (d) {
			var KIND = { lost_warehouse: ['Lost in warehouse', 'red'], damaged_warehouse: ['Damaged in warehouse', 'amber'], refund_no_return: ['Refunded, never returned', 'violet'], fee_overcharge: ['FBA fee overcharge', 'blue'] };
			var open = d.rows.filter(function (r) { return r.status === 'open'; });
			var k = h('div', { class: 'sgs-grid k4' },
				kpi('Recoverable (open)', money(open.reduce(function (a, r) { return a + num(r.est_amount); }, 0)), open.length + ' case(s) ready to file', 'tone-green'),
				kpi('Reimbursed by Amazon (12 mo)', money(d.summary.reimbursed_12m), 'from the reimbursements report'),
				kpi('Lost / damaged units', int(d.rows.filter(function (r) { return r.kind.indexOf('warehouse') >= 0; }).reduce(function (a, r) { return a + num(r.qty); }, 0)), 'in this view'),
				kpi('Refund-no-return orders', int(d.rows.filter(function (r) { return r.kind === 'refund_no_return'; }).length), '> 45 days old'));
			var t = table({
				title: 'Claims', sub: 'Each case comes with a ready-to-paste Seller Central message. Click a row → copy → open a case → mark as filed.', csv: 'reimbursement-claims', sort: 'est_amount',
				tools: seg([['open', 'Open'], ['filed', 'Filed'], ['reimbursed', 'Reimbursed'], ['dismissed', 'Dismissed'], ['all', 'All']], status, function (v) { window.location.hash = '#/reimbursements?status=' + v; }),
				columns: [
					{ key: 'kind', label: 'Type', render: function (r) { var x = KIND[r.kind] || [r.kind, '']; return badge(x[0], x[1]); } },
					{ key: 'sku', label: 'SKU / order', render: function (r) { return h('div', null, h('b', null, r.sku || '—'), h('div', { class: 'small muted mono' }, r.reference_id || r.fnsku)); } },
					{ key: 'qty', label: 'Units', align: 'r', fmt: int, sum: true },
					{ key: 'est_amount', label: 'Est. value', align: 'r', fmt: money, sum: true },
					{ key: 'event_date', label: 'Event', fmt: shortDate },
					{ key: 'status', label: 'Status', render: function (r) { return badge(r.status, { open: 'amber', filed: 'blue', reimbursed: 'green', dismissed: '' }[r.status]); } },
					{ key: 'amazon_case_id', label: 'Case ID', mono: true }
				],
				rows: d.rows, onRow: caseDrawer,
				actions: btn('Scan now', function () { return api('/reimbursements/scan', { method: 'POST' }).then(function (r) { toast(r.new + ' new case(s), ' + money(r.value) + ' total', 'ok'); route(); }); }, 'primary'),
				empty: empty('Nothing to claim', 'The auditor runs daily over your inventory ledger, refunds and fees.')
			});
			var recent = table({ title: 'Reimbursements received', csv: 'reimbursements', columns: [
				{ key: 'approval_date', label: 'Date', fmt: shortDate }, { key: 'reason', label: 'Reason' }, { key: 'sku', label: 'SKU' },
				{ key: 'qty_cash', label: 'Units (cash)', align: 'r', fmt: int }, { key: 'qty_inventory', label: 'Units (inventory)', align: 'r', fmt: int },
				{ key: 'amount', label: 'Amount', align: 'r', fmt: money, sum: true }, { key: 'case_id', label: 'Case', mono: true }
			], rows: d.recent });
			return h('div', { class: 'sgs-stack' }, pageHead('Reimbursements', 'Find money Amazon owes you: lost and damaged FBA inventory, refunds that were never returned, and FBA fee overcharges.'), k, t, recent);
		});
	};

	function caseDrawer(r) {
		var caseId = h('input', { type: 'text', value: r.amazon_case_id || '', placeholder: 'Seller Central case ID' });
		function set(status) { return api('/reimbursements/' + r.id, { method: 'POST', body: { status: status, amazon_case_id: caseId.value } }).then(function () { toast('Case updated', 'ok'); dr.close(); route(); }); }
		var ev = r.evidence || {};
		var dr = drawer('Claim · ' + (r.sku || r.reference_id), h('div', { class: 'sgs-stack' },
			h('dl', { class: 'kv' }, Object.keys(ev).map(function (k) { return [h('dt', null, k.replace(/_/g, ' ')), h('dd', null, String(ev[k]))]; })),
			card('Message for Seller Support', h('div', { class: 'sgs-stack' }, h('div', { class: 'pre' }, r.notes || ''), h('div', { class: 'btns' }, btn('Copy message', function () { return copy(r.notes || ''); }, 'primary'), h('a', { class: 'btn', href: 'https://sellercentral.amazon.' + (marketInfo().tld || 'com') + '/help/hub/support', target: '_blank', rel: 'noopener' }, 'Open Seller Support')))),
			card('Track', h('div', { class: 'btns' }, caseId, btn('Mark filed', function () { return set('filed'); }), btn('Reimbursed', function () { return set('reimbursed'); }, 'green'), btn('Dismiss', function () { return set('dismissed'); }, 'danger'))))
		);
	}

	/* ---------- Analytics: traffic, returns ---------- */
	PAGES.analytics = function () {
		var wrap = h('div', { class: 'sgs-stack' });
		function draw() {
			clear(wrap).appendChild(loading());
			Promise.all([api('/traffic', { query: rangeParams() }), api('/returns', { query: rangeParams() })]).then(function (res) {
				var t = res[0], r = res[1];
				var S = t.series;
				var sess = S.reduce(function (a, x) { return a + num(x.sessions); }, 0), units = S.reduce(function (a, x) { return a + num(x.units); }, 0);
				var bb = S.length ? S.reduce(function (a, x) { return a + num(x.buy_box_pct); }, 0) / S.length : null;
				var retUnits = r.by_reason.reduce(function (a, x) { return a + num(x.units); }, 0);
				clear(wrap);
				add(wrap, [
					pageHead('Traffic & Returns', 'Business Reports (sessions, page views, conversion, Buy Box %) per day and per ASIN, plus why customers return your products.', [rangeBar(draw)]),
					h('div', { class: 'sgs-grid k4' }, kpi('Sessions', int(sess)), kpi('Unit session %', sess ? pct(units / sess * 100, 2) : '—', int(units) + ' units'), kpi('Avg Buy Box %', pct(bb)), kpi('Returned units', int(retUnits), r.by_sku.length + ' SKUs')),
					card('Sessions & conversion', chart({ labels: S.map(function (x) { return x.date; }), series: [
						{ label: 'Sessions', values: S.map(function (x) { return x.sessions; }), type: 'bar', color: C.grey, fmt: int },
						{ label: 'Unit session %', values: S.map(function (x) { return num(x.sessions) ? num(x.units) / num(x.sessions) * 100 : null; }), type: 'line', color: C.profit, axis: 'right', fmt: function (v) { return pct(v, 1); } }
					], fmt: int, height: 220 })),
					table({ title: 'By ASIN', csv: 'traffic-by-asin', sort: 'sessions', columns: [
						{ key: 'asin', label: 'ASIN', mono: true, render: function (x) { return h('div', null, h('b', null, x.asin), h('div', { class: 'small muted' }, x.sku)); } },
						{ key: 'sessions', label: 'Sessions', align: 'r', fmt: int, sum: true }, { key: 'page_views', label: 'Page views', align: 'r', fmt: int, sum: true },
						{ key: 'units', label: 'Units', align: 'r', fmt: int, sum: true }, { key: 'cvr', label: 'Unit session %', align: 'r', fmt: function (v) { return pct(v, 2); } },
						{ key: 'buy_box_pct', label: 'Buy Box %', align: 'r', render: function (x) { return h('span', { class: num(x.buy_box_pct) < 90 ? 'neg' : '' }, pct(x.buy_box_pct)); } },
						{ key: 'sales', label: 'Ordered sales', align: 'r', fmt: money, sum: true }
					], rows: t.asins }),
					h('div', { class: 'sgs-grid k2' },
						card('Return reasons', h('ul', { class: 'list' }, r.by_reason.map(function (x) { return h('li', null, h('span', null, x.reason.replace(/_/g, ' ').toLowerCase()), h('div', { class: 'btns', style: { minWidth: '160px' } }, meter(num(x.units) / Math.max(1, retUnits) * 100, 'amber'), h('b', null, int(x.units)))); }))),
						table({ title: 'Returns by SKU', search: false, columns: [{ key: 'sku', label: 'SKU' }, { key: 'units', label: 'Returned', align: 'r', fmt: int }, { key: 'sellable', label: 'Back to stock', align: 'r', fmt: int }], rows: r.by_sku })),
					table({ title: 'Return log', csv: 'returns', columns: [
						{ key: 'return_date', label: 'Date', fmt: shortDate }, { key: 'amazon_order_id', label: 'Order', mono: true }, { key: 'sku', label: 'SKU' },
						{ key: 'qty', label: 'Qty', align: 'r' }, { key: 'reason', label: 'Reason' }, { key: 'disposition', label: 'Disposition', render: function (x) { return badge(x.disposition, x.disposition === 'SELLABLE' ? 'green' : 'red'); } },
						{ key: 'comments', label: 'Customer comment' }
					], rows: r.rows })
				]);
			}, function (e) { clear(wrap).appendChild(failure(e)); });
		}
		draw();
		return wrap;
	};

	/* ---------- Research ---------- */
	PAGES.research = function () {
		var kw = h('input', { type: 'text', placeholder: 'e.g. sugar free gum', style: { minWidth: '320px' } });
		var slot = h('div');
		function search() {
			if (!kw.value.trim()) { return Promise.resolve(); }
			clear(slot).appendChild(loading());
			return api('/research/search', { method: 'POST', body: { keywords: kw.value } }).then(function (d) {
				var S = d.summary;
				clear(slot).appendChild(h('div', { class: 'sgs-stack' },
					h('div', { class: 'sgs-grid k5' },
						kpi('Opportunity score', S.opportunity === null ? '—' : S.opportunity + '/100', 'demand vs competition vs price', num(S.opportunity) >= 60 ? 'tone-green' : (num(S.opportunity) >= 40 ? 'tone-amber' : 'tone-red')),
						kpi('Avg price', money(S.avg_price)), kpi('Avg monthly units', int(S.avg_units), 'BSR estimate ±40%'),
						kpi('Page-1 revenue / mo', money0(S.total_revenue)), kpi('Top-3 share', pct(S.top3_share_pct), 'revenue concentration')),
					table({ title: 'Results', csv: 'research-' + kw.value.replace(/\W+/g, '-'), sort: 'est_revenue', columns: [
						{ key: 'image', label: '', sort: false, csv: false, render: function (r) { return r.image ? h('img', { class: 'thumb', src: r.image, alt: '', loading: 'lazy' }) : ''; } },
						{ key: 'title', label: 'Product', render: function (r) { return h('div', null, h('a', { href: amazonUrl(r.asin), target: '_blank', rel: 'noopener', class: 'title' }, r.title), h('div', { class: 'small muted' }, r.asin + ' · ' + (r.brand || '—') + ' · ' + (r.category || ''))); } },
						{ key: 'price', label: 'Price', align: 'r', fmt: money },
						{ key: 'bsr', label: 'BSR', align: 'r', fmt: int },
						{ key: 'est_units', label: 'Est. units/mo', align: 'r', fmt: int },
						{ key: 'est_revenue', label: 'Est. revenue/mo', align: 'r', fmt: money0 },
						{ key: 'offers', label: 'Offers', align: 'r', fmt: int },
						{ key: 'asin', label: '', sort: false, csv: false, render: function (r) { return btn('Fees', function () { return feeLookup(r.asin, r.price); }, 'sm'); } }
					], rows: d.items })));
			}, function (e) { clear(slot).appendChild(failure(e)); });
		}
		kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { search(); } });

		var f = {};
		['price', 'unit_cost', 'inbound', 'referral_pct', 'fba_fee', 'storage_per_unit', 'tacos_pct', 'return_pct', 'cvr_pct'].forEach(function (k) { f[k] = h('input', { type: 'number', step: '0.01', min: '0' }); });
		f.price.value = '16.99'; f.unit_cost.value = '4.20'; f.inbound.value = '0.50'; f.referral_pct.value = '15'; f.fba_fee.value = '4.02'; f.storage_per_unit.value = '0.10'; f.tacos_pct.value = '10'; f.return_pct.value = '2'; f.cvr_pct.value = '12';
		var out = h('div');
		function calc() {
			var body = {}; Object.keys(f).forEach(function (k) { body[k] = f[k].value; });
			return api('/research/calc', { method: 'POST', body: body }).then(function (r) {
				clear(out).appendChild(h('div', { class: 'sgs-grid k4' },
					kpi('Profit / unit', money(r.profit_per_unit), 'Margin ' + pct(r.margin_pct), num(r.profit_per_unit) >= 0 ? 'tone-green' : 'tone-red'),
					kpi('ROI', pct(r.roi_pct), 'on ' + money(r.cogs) + ' landed cost'),
					kpi('Break-even ACoS', pct(r.breakeven_acos), 'Max CPC ' + money(r.max_cpc) + ' at your CVR'),
					kpi('Break-even price', money(r.breakeven_price), 'Amazon fees ' + money(r.amazon_fees))));
			});
		}
		var calcCard = card('FBA profitability calculator', h('div', { class: 'sgs-stack' }, h('div', { class: 'form-grid' },
			field('Sale price', f.price), field('Unit cost', f.unit_cost), field('Inbound / unit', f.inbound), field('Referral %', f.referral_pct, 'Grocery: 8% ≤ $15, 15% above'),
			field('FBA fee', f.fba_fee, 'Use “Fees” on a result for Amazon’s exact estimate'), field('Storage / unit', f.storage_per_unit), field('TACoS %', f.tacos_pct), field('Return rate %', f.return_pct), field('Ad conversion %', f.cvr_pct)),
			h('div', { class: 'btns' }, btn('Calculate', calc, 'primary')), out));

		function feeLookup(asin, price) {
			return api('/research/fees', { method: 'POST', body: { asin: asin, price: price || f.price.value } }).then(function (r) {
				f.fba_fee.value = num(r.fba).toFixed(2);
				if (r.price) { f.price.value = r.price; f.referral_pct.value = r.price ? (num(r.referral) / num(r.price) * 100).toFixed(1) : f.referral_pct.value; }
				toast('Fees for ' + asin + ': ' + money(r.total) + ' (referral ' + money(r.referral) + ', FBA ' + money(r.fba) + ')', 'ok');
				return calc();
			});
		}
		var asinFee = h('input', { type: 'text', placeholder: 'ASIN' });
		var feeCard = card('Exact Amazon fees for any ASIN', h('div', { class: 'btns' }, asinFee, btn('Get fees', function () { return feeLookup(asinFee.value.trim().toUpperCase(), f.price.value); })), { sub: 'Product Fees API — fills the calculator.' });

		return h('div', { class: 'sgs-stack' },
			pageHead('Product Research', 'Size up any niche from the official catalog: BSR-based sales estimates, page-1 revenue, competition, and exact FBA fees — then model your profit.'),
			card('Niche explorer', h('div', { class: 'sgs-stack' }, h('div', { class: 'btns' }, kw, btn('Search Amazon', search, 'primary')), slot)),
			h('div', { class: 'sgs-grid k21' }, calcCard, feeCard));
	};

	/* ---------- Reports ---------- */
	PAGES.reports = function () {
		return api('/reports').then(function (d) {
			var cat = table({ title: 'Report catalog', search: false, columns: [
				{ key: 'label', label: 'Report', render: function (r) { return h('div', null, h('b', null, r.label), h('div', { class: 'small muted mono' }, r.type)); } },
				{ key: 'schedule', label: 'Auto', render: function (r) { return badge(r.schedule, r.schedule === 'daily' ? 'green' : 'blue'); } },
				{ key: 'window', label: 'Window', render: function (r) { return r.window ? r.window + ' days' : 'snapshot'; } },
				{ key: 'type', label: '', sort: false, render: function (r) { return btn('Request now', function () { return api('/reports', { method: 'POST', body: { type: r.type } }).then(function () { toast('Requested ' + r.label, 'ok'); route(); }); }, 'sm'); } }
			], rows: d.catalog });
			var STATUS_C = { completed: 'green', requested: 'blue', processing: 'blue', failed: 'red', empty: '' };
			var rows = table({ title: 'Recent report runs', csv: 'report-runs', sort: 'requested_at', columns: [
				{ key: 'requested_at', label: 'Requested', fmt: function (v) { return dateTime(v); } },
				{ key: 'report_type', label: 'Type', render: function (r) { return h('span', { class: 'small mono' }, r.report_type); } },
				{ key: 'source', label: 'API', render: function (r) { return badge(r.source === 'ads' ? 'Ads' : 'SP'); } },
				{ key: 'market', label: 'Mkt' },
				{ key: 'data_start', label: 'Range', render: function (r) { return r.data_start ? shortDate(r.data_start) + ' – ' + shortDate(r.data_end) : '—'; } },
				{ key: 'status', label: 'Status', render: function (r) { return badge(r.status, STATUS_C[r.status]); } },
				{ key: 'rows_ingested', label: 'Rows', align: 'r', fmt: int },
				{ key: 'error', label: 'Error', render: function (r) { return h('span', { class: 'small neg' }, r.error || ''); } }
			], rows: d.rows, actions: btn('Poll now', function () { return api('/reports/poll', { method: 'POST' }).then(function (r) { toast(r.completed + ' completed, ' + r.rows + ' rows ingested', 'ok'); route(); }); }, 'primary') });
			return h('div', { class: 'sgs-stack' }, pageHead('Reports Center', 'Every Amazon report the suite uses — requested on schedule, polled, downloaded, decompressed and ingested automatically.'), cat, rows, jobsCard(d.jobs));
		});
	};

	function jobsCard(jobs) {
		var keys = Object.keys(jobs || {});
		return card('Background jobs', keys.length ? h('ul', { class: 'list' }, keys.map(function (k) {
			var j = jobs[k];
			return h('li', null, h('span', null, h('b', null, k), ' ', h('span', { class: 'muted small' }, new Date(j.at * 1000).toLocaleString())), j.ok ? badge('ok', 'green') : h('span', { class: 'small neg', title: j.error }, '✕ ' + (j.error || '').slice(0, 90)));
		})) : empty('No runs yet', 'Jobs run on WP-Cron every 15 minutes, hourly and daily.'));
	}

	/* ---------- Alerts ---------- */
	PAGES.alerts = function () {
		return api('/alerts').then(function (d) {
			state.unread = d.unread;
			return h('div', { class: 'sgs-stack' }, pageHead('Alerts', 'Hijackers, Buy Box losses, listing changes, negative feedback, competitor price drops and more. Critical alerts can also go to email (Settings).', [btn('Mark all read', function () { return api('/alerts', { method: 'POST' }).then(route); })]),
				table({ title: d.rows.length + ' alerts', csv: 'alerts', sort: 'created_at', columns: [
					{ key: 'created_at', label: 'When', fmt: function (v) { return dateTime(v); } },
					{ key: 'level', label: 'Level', render: function (r) { return badge(r.level, r.level === 'critical' ? 'red' : (r.level === 'warning' ? 'amber' : 'blue')); } },
					{ key: 'category', label: 'Category' },
					{ key: 'title', label: 'Alert', render: function (r) { return h('div', null, h('b', { style: { fontWeight: +r.is_read ? 400 : 700 } }, r.title), r.message ? h('div', { class: 'small muted' }, r.message) : null); } }
				], rows: d.rows, empty: empty('No alerts', 'You will see hijacker, Buy Box, feedback and listing-change alerts here.') }));
		});
	};

	/* ---------- Settings ---------- */
	PAGES.settings = function () {
		return api('/settings').then(function (d) {
			var S = d.settings;
			var inputs = {};
			function inp(key, type, attrs) {
				var el;
				if (type === 'bool') { el = h('input', { type: 'checkbox', checked: !!S[key] }); }
				else if (type === 'select') { el = h('select', null, attrs.options.map(function (o) { return h('option', { value: o[0], selected: String(S[key]) === String(o[0]) }, o[1]); })); }
				else { el = h('input', Object.assign({ type: type || 'text', value: S[key] === null || S[key] === undefined ? '' : S[key] }, attrs || {})); }
				inputs[key] = el;
				return el;
			}
			function chk(key, label) { return h('label', { class: 'check' }, inp(key, 'bool'), label); }
			function secret(key, label, help) {
				var el = h('input', { type: 'password', autocomplete: 'off', placeholder: S['has_' + key] ? '•••••••• saved — leave blank to keep' : '' });
				inputs[key] = el;
				return field(label, el, help);
			}
			var sellerId = h('input', { type: 'text', placeholder: S.seller_id_set ? '•••••• saved — leave blank to keep' : 'e.g. A1B2C3D4E5F6G7' });
			inputs.amazon_seller_id = sellerId;

			function collect() {
				var out = {};
				Object.keys(inputs).forEach(function (k) {
					var el = inputs[k];
					out[k] = el.type === 'checkbox' ? el.checked : el.value;
				});
				return out;
			}
			function save() { return api('/settings', { method: 'POST', body: collect() }).then(function () { toast('Settings saved', 'ok'); }); }

			var profileSlot = h('div');
			var g = function (title, sub, children) { return card(title, h('div', { class: 'form-grid' }, children), { sub: sub }); };

			var sync = g('Data sync', 'Orders every 15 min, finances hourly, reports daily/weekly. First run backfills history.', [
				chk('suite_sync_enabled', 'Background sync enabled'),
				field('Backfill days', inp('suite_backfill_days', 'number', { min: 7, max: 730 })),
				field('Order items per tick', inp('suite_order_items_per_run', 'number', { min: 5, max: 100 }), 'Orders API item calls per 15 min'),
				field('Seller ID (Merchant Token)', sellerId, 'Seller Central → Settings → Account Info → Merchant Token. Needed for listing audits & hijacker detection.')
			]);
			var profit = g('Profit', null, [
				field('Default unit cost', inp('suite_default_unit_cost', 'number', { step: '0.01' }), 'Used when a SKU has no cost'),
				chk('suite_include_tax', 'Count collected tax as revenue (not recommended)')
			]);
			var restock = g('Restock planner', null, [
				field('Default lead time (days)', inp('suite_lead_time_days', 'number')), field('Safety stock (days)', inp('suite_safety_days', 'number')),
				field('Target cover after arrival (days)', inp('suite_target_cover_days', 'number')), field('Overstock threshold (days)', inp('suite_overstock_days', 'number'))
			]);
			var ads = g('Amazon Ads API (PPC)', 'Create an LWA security profile approved for the Advertising API, then generate a refresh token with scope advertising::campaign_management. Leave client ID/secret blank to reuse the SP-API app.', [
				chk('suite_ads_enabled', 'Sync ads daily'),
				field('Region', inp('suite_ads_region', 'select', { options: [['na', 'North America'], ['eu', 'Europe / Middle East'], ['fe', 'Far East']] })),
				secret('ads_client_id', 'Ads client ID'), secret('ads_client_secret', 'Ads client secret'), secret('ads_refresh_token', 'Ads refresh token'),
				field('Profile ID', inp('suite_ads_profile_id'), 'Use “Test & list profiles”'),
				h('div', { class: 'field' }, h('label', null, ' '), btn('Test & list profiles', function () {
					return api('/ads/test', { method: 'POST', body: collect() }).then(function (r) {
						clear(profileSlot).appendChild(h('ul', { class: 'list' }, r.profiles.map(function (p) {
							return h('li', null, h('span', null, h('b', null, p.countryCode + ' · ' + p.name), ' ', h('span', { class: 'muted mono small' }, p.profileId + ' · ' + p.type + ' · ' + p.currency)), btn('Use', function () { inputs.suite_ads_profile_id.value = p.profileId; return save(); }, 'sm'));
						})));
						toast('Ads API connected — ' + r.profiles.length + ' profile(s)', 'ok');
					});
				})),
				h('div', { style: { gridColumn: '1 / -1' } }, profileSlot)
			]);
			var opt = g('PPC optimizer rules', 'Plans are reviewed in PPC → Optimizer. Auto-apply pushes only bid changes and negatives.', [
				field('Target ACoS %', inp('suite_ads_target_acos', 'number', { step: '0.5' })), field('Lookback days', inp('suite_ads_lookback_days', 'number')),
				field('Min clicks before cutting', inp('suite_ads_min_clicks', 'number')), field('Max bid step %', inp('suite_ads_max_step_pct', 'number')),
				field('Min bid', inp('suite_ads_min_bid', 'number', { step: '0.01' })), field('Max bid', inp('suite_ads_max_bid', 'number', { step: '0.01' })),
				field('Negate after clicks (0 orders)', inp('suite_ads_neg_min_clicks', 'number')), field('Harvest after orders', inp('suite_ads_harvest_min_orders', 'number')),
				field('Harvest → campaign ID', inp('suite_ads_harvest_campaign')), field('Harvest → ad group ID', inp('suite_ads_harvest_ad_group')),
				chk('suite_ads_raise_low_impr', 'Raise bids on low-impression keywords'), chk('suite_ads_auto_apply', 'Auto-apply bids & negatives daily')
			]);
			var reviews = g('Review requests', 'Uses Amazon’s Solicitations API — the compliant “Request a Review” button.', [
				chk('suite_reviews_enabled', 'Send review requests automatically'),
				field('Days after delivery', inp('suite_reviews_delay_days', 'number', { min: 5, max: 29 })), field('Daily cap', inp('suite_reviews_daily_cap', 'number')),
				chk('suite_reviews_skip_refunded', 'Skip refunded / returned orders')
			]);
			var mon = g('Monitoring & alerts', null, [
				chk('suite_monitor_enabled', 'Monitor Buy Box, hijackers & competitors'),
				field('Competitor price-drop alert %', inp('suite_monitor_price_drop_pct', 'number')),
				field('Extra competitor ASINs', inp('suite_monitor_extra_asins', 'text', { placeholder: 'B0…, B0…' })),
				field('Alert email', inp('suite_alert_email', 'email', { placeholder: 'defaults to site admin email' })),
				field('Email these levels', inp('suite_alert_email_levels', 'select', { options: [['critical', 'Critical only'], ['critical,warning', 'Critical + warning'], ['critical,warning,info', 'Everything'], ['none', 'Never']] }))
			]);
			var nr = d.next_runs || {};
			var ops = card('Run now', h('div', { class: 'sgs-stack' },
				h('div', { class: 'btns' },
					[['orders', 'Sync orders'], ['finance', 'Sync finances'], ['reports', 'Request daily reports'], ['weekly', 'Request weekly reports'], ['poll', 'Poll reports'], ['backfill', 'Backfill history']].map(function (j) {
						return btn(j[1], function () { return api('/sync', { method: 'POST', body: { job: j[0] } }).then(function (r) { toast(j[1] + ': ' + JSON.stringify(r.result).slice(0, 120), 'ok'); }); }, 'sm');
					})),
				h('div', { class: 'small muted' }, 'Next runs — tick: ' + (nr.sg_suite_tick ? dateTime(nr.sg_suite_tick) : 'not scheduled') + ' · hourly: ' + (nr.sg_suite_hourly ? dateTime(nr.sg_suite_hourly) : 'not scheduled') + ' · daily: ' + (nr.sg_suite_daily ? dateTime(nr.sg_suite_daily) : 'not scheduled')),
				h('div', { class: 'divider' }),
				h('div', { class: 'btns' }, state.demo ? btn('Remove demo data', function () { return api('/demo', { method: 'DELETE' }).then(function () { state.demo = false; route(); }); }, 'danger') : btn('Load demo account', seedDemo))
			), { sub: d.connected ? 'SP-API connected.' : 'SP-API not connected — set credentials in Seven Gum → Amazon Connect.' });

			return h('div', { class: 'sgs-stack' },
				pageHead('Suite Settings', 'Everything is configurable; secrets are encrypted with AES-256-GCM and never sent back to the browser.', [btn('Save settings', save, 'primary')]),
				h('div', { class: 'sgs-grid k2' }, sync, profit), ads, opt, h('div', { class: 'sgs-grid k2' }, restock, reviews), mon, ops, jobsCard(d.jobs),
				h('div', { class: 'btns' }, btn('Save settings', save, 'primary')));
		});
	};

	/* ================================================================== */
	/* Boot                                                               */
	/* ================================================================== */

	clear(root);
	add(root, [headerSlot, nav, bannerSlot, main]);
	window.addEventListener('hashchange', route);
	route();
})();
