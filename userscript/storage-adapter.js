// A lexical adapter: shared code can use chrome.storage without changing the page's chrome object.
// Userscripts run in the page world, so snapshots live in this origin's localStorage.
const chrome = (() => {
	const prefix = 'claude-counter:userscript:';
	const memory = new Map();
	const local = {
		get(keys, callback) {
			const defaults = !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
			const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(defaults);
			const result = {};
			for (const key of names) {
				let value = memory.get(key);
				try {
					const raw = localStorage.getItem(prefix + key);
					if (raw !== null) value = JSON.parse(raw);
				} catch { /* Storage may be unavailable; keep the in-memory snapshot. */ }
				result[key] = value === undefined ? defaults[key] : value;
			}
			callback?.(result);
			return Promise.resolve(result);
		},
		set(items, callback) {
			for (const [key, value] of Object.entries(items)) {
				memory.set(key, value);
				try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch {}
			}
			callback?.();
			return Promise.resolve();
		}
	};
	return { storage: { local, sync: local } };
})();
