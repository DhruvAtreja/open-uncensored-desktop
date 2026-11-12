// The only bridge between the page and the system: no Node in the renderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ou", {
  platform: process.platform, // "darwin" or "win32": the page lays out the title bar to match
  getKey: () => ipcRenderer.invoke("key:get"),
  setKey: (key) => ipcRenderer.invoke("key:set", key),
  getConversations: () => ipcRenderer.invoke("conversations:get"),
  setConversations: (list) => ipcRenderer.invoke("conversations:set", list),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  pickFiles: () => ipcRenderer.invoke("files:pick"),
  defaultFolder: () => ipcRenderer.invoke("folder:default"),
  openUrl: (url) => ipcRenderer.invoke("open:url", url),
  readImage: (file) => ipcRenderer.invoke("image:read", file),
  openImage: (file) => ipcRenderer.invoke("image:open", file),
  pasteImage: (bytes, type) => ipcRenderer.invoke("image:paste", { bytes, type }),
  // Where a dropped or pasted file lives on disk ("" for one with no file behind it, such as an
  // image dragged out of a web page).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  request: (opts) => ipcRenderer.invoke("net:request", opts),
  startChat: (opts) => ipcRenderer.invoke("chat:start", opts),
  stopChat: (streamId) => ipcRenderer.invoke("chat:stop", streamId),
  onChatEvent: (fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.removeListener("chat:event", listener);
  },
  getUpdate: () => ipcRenderer.invoke("update:get"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdate: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  startAgent: (opts) => ipcRenderer.invoke("agent:start", opts),
  stopAgent: (runId) => ipcRenderer.invoke("agent:stop", runId),
  onAgentEvent: (fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
