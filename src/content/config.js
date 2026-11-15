(() => {
	'use strict';
	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	CC.config = Object.freeze({
		// Set to true to show the approximate token count at the left of the usage row.
		// It estimates visible history and can be inaccurate after compaction.
		showTokenCounter: false
	});
})();
