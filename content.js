// Inject overlay when LinkedIn loads
if (!document.getElementById("get-off-linkedin-root")) {
  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("overlay.html");
  iframe.id = "get-off-linkedin-root";

  iframe.style.position = "fixed";
  iframe.style.top = "20px";
  iframe.style.right = "20px";
  iframe.style.width = "440px";
  iframe.style.height = "480px";
  iframe.style.zIndex = "999999";
  iframe.style.border = "1px solid #ddd";
  iframe.style.borderRadius = "12px";
  iframe.style.background = "white";

  document.body.appendChild(iframe);
}
