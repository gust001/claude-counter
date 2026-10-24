(() => {
	'use strict';
	const CC = globalThis.ClaudeCounter;
	CC.mountAutoForm(document.getElementById('autoForm'));
	document.getElementById('openOptions').addEventListener('click', () => {
		chrome.runtime.openOptionsPage();
		window.close();
	});
})();
