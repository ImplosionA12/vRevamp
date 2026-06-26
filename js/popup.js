let viewOfflineButton = document.getElementById("view-offline");

viewOfflineButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    message: "showOfflinePage",
  });
});
