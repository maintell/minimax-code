import { createOfficeEditorBroker } from "./office-editor-broker";
const broker = createOfficeEditorBroker('excel-editor');
export let setupExcelEditorIPC = broker.setup;
export let handleExcelEditorBrokerMessage = broker.handleMessage;
