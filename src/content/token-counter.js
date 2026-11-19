(() => {
	'use strict';
	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	let tokenizerReady;
	CC.ensureTokenizer = () => {
		if (!tokenizerReady) tokenizerReady = (async () => {
			if (CC.loadUserscriptTokenizer) await CC.loadUserscriptTokenizer();
			else {
				const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
				if (!runtime?.getURL) throw new Error('Tokenizer unavailable');
				await import(runtime.getURL('src/vendor/o200k_base.js'));
			}
			if (!globalThis.GPTTokenizer_o200k_base?.countTokens) throw new Error('Tokenizer unavailable');
		})().catch((error) => { tokenizerReady = null; throw error; });
		return tokenizerReady;
	};

	class OptionalTokenCounter {
		constructor({ ui, bridgeReady, getOrgId, onActiveOrgChange }) {
			this.ui = ui;
			this.bridgeReady = bridgeReady;
			this.getOrgId = getOrgId;
			this.enabled = false;
			this.revision = 0;
			this.turnRevision = 0;
			this.messageCount = 0;
			CC.bridge.on('cc:turn_end', () => this._afterTurn());
			const navigate = () => {
				this.revision++;
				this.turnRevision++;
				clearTimeout(this.turnTimer);
				this.messageCount = 0;
				this._render();
				if (this.enabled) this.refresh();
			};
			// Follow the content script's *active* organisation (issue #2). IDs merely seen in page
			// requests are not switches; reacting to them used to throw away valid counts.
			onActiveOrgChange?.((orgId, previous) => {
				if (!this.enabled) return;
				if (previous) navigate();
				else if (!this.hasCount) this.refresh();
			});
			// claude.ai rewrites history (query strings, state) without leaving the chat. Every such
			// event used to cancel the count and download the whole conversation again; only a
			// different chat is a navigation for the counter (#4).
			this.lastChatId = this._chatId();
			const onLocation = () => {
				const chatId = this._chatId();
				if (chatId === this.lastChatId) return;
				this.lastChatId = chatId;
				navigate();
			};
			window.addEventListener('cc:urlchange', onLocation);
			window.addEventListener('popstate', onLocation);
			document.addEventListener('click', (event) => {
				if (!this.enabled || !event.target?.closest?.('button[aria-label="Previous"], button[aria-label="Next"]')) return;
				clearTimeout(this.branchTimer);
				this.branchTimer = setTimeout(navigate, 500);
			});
			this.setEnabled(CC.config?.showTokenCounter === true);
		}

		_chatId() {
			return window.location.pathname.match(/\/chat\/([^/?]+)/)?.[1] || null;
		}

		_render(totalTokens = null, status = 'loading') {
			this.hasCount = typeof totalTokens === 'number';
			this.ui.setTokenCounter({ enabled: this.enabled, active: !!this._chatId(), totalTokens, status });
		}

		setEnabled(enabled) {
			this.enabled = enabled === true;
			this.revision++;
			this.turnRevision++;
			clearTimeout(this.turnTimer);
			clearTimeout(this.branchTimer);
			this._render();

			if (this.enabled) return this.refresh();
		}

		refresh() {
			const chatId = this._chatId();
			if (!this.enabled || !chatId) return Promise.resolve(null);
			const revision = this.revision;
			if (this.inFlight?.revision === revision) return this.inFlight.promise;
			const request = { revision };
			const current = () => this.enabled && this.revision === revision && this._chatId() === chatId;
			request.promise = (async () => {
				try {
					await this.bridgeReady;
					await CC.ensureTokenizer();
					if (!current()) return null;
					const orgId = await this.getOrgId();
					if (!current()) return null;
					if (!orgId) throw new Error('Organisation unavailable');
					const data = await CC.bridge.requestConversation(orgId, chatId);
					if (!current()) return null;
					if (!Array.isArray(data?.chat_messages)) throw new Error('Conversation unavailable');
					const metrics = await CC.tokens.computeConversationMetrics(data);
					if (!current()) return null;
					this.messageCount = metrics.trunkMessageCount;
					this._render(metrics.totalTokens, 'ready');
					return metrics.trunkMessageCount;
				} catch {
					if (current()) this._render(null, 'error');
					return null;
				} finally {
					if (this.inFlight === request) this.inFlight = null;
				}
			})();
			this.inFlight = request;
			return request.promise;
		}

		_afterTurn() {
			if (!this.enabled || !this._chatId()) return;
			const turn = ++this.turnRevision;
			const before = this.messageCount;
			const delays = [1200, 5000, 12000];
			clearTimeout(this.turnTimer);
			const retry = (index) => {
				this.turnTimer = setTimeout(async () => {
					if (!this.enabled || turn !== this.turnRevision) return;
					const count = await this.refresh();
					if (this.enabled && turn === this.turnRevision && !(count > before) && index + 1 < delays.length) retry(index + 1);
				}, delays[index]);
			};
			retry(0);
		}
	}
	CC.OptionalTokenCounter = OptionalTokenCounter;
})();
