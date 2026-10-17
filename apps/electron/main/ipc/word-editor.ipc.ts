import { createOfficeEditorBroker } from "./office-editor-broker";
const broker = createOfficeEditorBroker('word-editor');
export let setupWordEditorIPC = broker.setup;
export let handleWordEditorBrokerMessage = broker.handleMessage;
