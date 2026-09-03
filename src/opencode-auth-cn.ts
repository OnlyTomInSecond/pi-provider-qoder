import { createQoderAuthHooks, type QoderOpenCodePlugin } from "./opencode-auth.js";

const qoderCnOpenCodePlugin: QoderOpenCodePlugin = async () => createQoderAuthHooks("cn");

export default qoderCnOpenCodePlugin;
