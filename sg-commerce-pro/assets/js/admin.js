/* Seven Gum Commerce — admin JS enhancements (minimal). */
(function() {
	// Auto-dismiss flash notices after 6 seconds.
	setTimeout(function() {
		var notices = document.querySelectorAll('.notice.is-dismissible');
		notices.forEach(function(n) { n.style.transition = 'opacity 0.4s'; n.style.opacity = '0'; });
		setTimeout(function() {
			notices.forEach(function(n) { n.style.display = 'none'; });
		}, 400);
	}, 6000);
})();
