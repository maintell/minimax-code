import { UtilityOfficeEditorClient } from "./office-editor-broker";
export class UtilityWordEditorClient extends UtilityOfficeEditorClient {
    constructor(send) {
        super(send, 'word-editor');
    }
}

