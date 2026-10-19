/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */
import { FfiConverterUInt64, } from "./ffi-converters.js";
import { UniffiHandleMap, defaultUniffiHandle, } from "./handle-map.js";
import { CALL_ERROR, CALL_UNEXPECTED_ERROR, } from "./rust-call.js";
const handleConverter = FfiConverterUInt64;
export class FfiConverterCallback {
    handleMap;
    constructor(handleMap = new UniffiHandleMap()) {
        this.handleMap = handleMap;
    }
    lift(value) {
        return this.handleMap.get(value);
    }
    lower(value, _alloc) {
        return this.handleMap.insert(value);
    }
    read(from) {
        return this.lift(handleConverter.read(from));
    }
    write(value, into) {
        handleConverter.write(this.handleMap.insert(value), into);
    }
    allocationSize(value) {
        return handleConverter.allocationSize(defaultUniffiHandle);
    }
    clone(handle) {
        return this.handleMap.clone(handle);
    }
    drop(handle) {
        return this.handleMap.remove(handle);
    }
}
export function uniffiTraitInterfaceCall(makeCall, handleSuccess, handleError, lowerString, alloc) {
    try {
        handleSuccess(makeCall());
    }
    catch (e) {
        handleError(CALL_UNEXPECTED_ERROR, lowerString(e.toString(), alloc));
    }
}
export function uniffiTraitInterfaceCallWithError(makeCall, handleSuccess, handleError, isErrorType, lowerError, lowerString, alloc) {
    try {
        handleSuccess(makeCall());
    }
    catch (e) {
        // Hermes' prototype chain seems buggy, so we need to make our
        // own arrangements
        if (isErrorType(e)) {
            handleError(CALL_ERROR, lowerError(e, alloc));
        }
        else {
            handleError(CALL_UNEXPECTED_ERROR, lowerString(e.toString(), alloc));
        }
    }
}
//# sourceMappingURL=callbacks.js.map