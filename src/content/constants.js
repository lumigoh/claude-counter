(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		CHAT_HEADER_ANCHOR: '[data-testid="chat-title-split"], [data-testid="chat-title-button"], [data-testid="chat-menu-trigger"], [data-testid="conversation-title"], header h1',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_INPUT: '[data-testid="chat-input"], div[contenteditable="true"], textarea',
		COMPOSER: '[data-cds="ChatComposer"], .bg-surface-3, fieldset, form',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});


	CC.CONST = Object.freeze({ CACHE_WINDOW_MS: 5 * 60 * 1000 });

	/**
	 * Whether a value can be an organisation ID (#5). Deliberately permissive, because the ID format
	 * is not a documented contract: URL-safe characters, 8-128 long, and at least one digit, which
	 * rules out route words such as `discoverable`. A copy lives in src/injected/bridge.js, which
	 * runs in the page world and cannot share this object.
	 */
	CC.isPlausibleOrgId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) && /\d/.test(id);

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();
