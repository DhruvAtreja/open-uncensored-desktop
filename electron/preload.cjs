// The only bridge between the page and the system: no Node in the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ou", {
  getKey: () => ipcRenderer.invoke("key:get"),
  setKey: (key) => ipcRenderer.invoke("key:set", key),
  getConversations: () => ipcRenderer.invoke("conversations:get"),
  setConversations: (list) => ipcRenderer.invoke("conversations:set", list),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  defaultFolder: () => ipcRenderer.invoke("folder:default"),
  openUrl: (url) => ipcRenderer.invoke("open:url", url),
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
