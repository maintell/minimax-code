"use strict";
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FfiConverterObjectAsError = exports.FfiConverterObjectWithCallbacks = exports.FfiConverterObject = exports.UniffiAbstractObject = void 0;
const ffi_converters_ts_1 = require("./ffi-converters.js");
const handle_map_ts_1 = require("./handle-map.js");
const errors_ts_1 = require("./errors.js");
/**
 * Marker interface for all `interface` objects that cross the FFI.
 * Reminder: `interface` objects have methods written in Rust.
 *
 * This typesscript interface contains the unffi methods that are needed to make
 * the FFI work. It should shrink to zero methods.
 */
class UniffiAbstractObject {
    /**
     * A convenience method to use this object, then destroy it after its use.
     * @param block
     * @returns
     */
    uniffiUse(block) {
        const v = block(this);
        this.uniffiDestroy();
        return v;
    }
}
exports.UniffiAbstractObject = UniffiAbstractObject;
const pointerConverter = ffi_converters_ts_1.FfiConverterUInt64;
const dummyPointer = BigInt("0");
/**
 * An FfiConverter for an object.
 */
class FfiConverterObject {
    factory;
    constructor(factory) {
        this.factory = factory;
    }
    lift(value) {
        return this.factory.create(value);
    }
    lower(value, _alloc) {
        return this.lowerHandle(value);
    }
    read(from) {
        return this.lift(pointerConverter.read(from));
    }
    write(value, into) {
        pointerConverter.write(this.lowerHandle(value), into);
    }
    lowerHandle(value) {
        if (this.factory.isConcreteType(value)) {
            return this.factory.clonePointer(value);
        }
        else {
            throw new Error("Cannot lower this object to a pointer");
        }
    }
    allocationSize(value) {
        return pointerConverter.allocationSize(dummyPointer);
    }
}
exports.FfiConverterObject = FfiConverterObject;
/// An FfiConverter for objects with callbacks.
class FfiConverterObjectWithCallbacks extends FfiConverterObject {
    handleMap;
    constructor(factory, handleMap = new handle_map_ts_1.UniffiHandleMap()) {
        super(factory);
        this.handleMap = handleMap;
    }
    lower(value, alloc) {
        // Rust-backed objects are lowered as raw Arc pointers (even numbers).
        // TS-implemented objects are inserted into the handleMap as foreign handles (odd numbers).
        if (this.factory.isConcreteType(value)) {
            return super.lower(value, alloc);
        }
        return this.handleMap.insert(value);
    }
    lift(value) {
        if (this.handleMap.has(value)) {
            return this.handleMap.get(value);
        }
        else {
            return super.lift(value);
        }
    }
    drop(handle) {
        return this.handleMap.remove(handle);
    }
    /**
     * Called by Rust's `CallbackInterfaceClone` vtable entry when it clones an
     * Arc holding a foreign-implemented object. Returns a new handle pointing to
     * the same JS object; removing either handle does not affect the other.
     */
    clone(handle) {
        return this.handleMap.clone(handle);
    }
}
exports.FfiConverterObjectWithCallbacks = FfiConverterObjectWithCallbacks;
/// Due to some mismatches in the ffi converter mechanisms, errors are a RustBuffer holding a pointer
class FfiConverterObjectAsError extends ffi_converters_ts_1.AbstractFfiConverterByteArray {
    typeName;
    innerConverter;
    constructor(typeName, innerConverter) {
        super();
        this.typeName = typeName;
        this.innerConverter = innerConverter;
    }
    read(from) {
        const obj = this.innerConverter.read(from);
        return new errors_ts_1.UniffiThrownObject(this.typeName, obj);
    }
    write(value, into) {
        const obj = value.inner;
        this.innerConverter.write(obj, into);
    }
    allocationSize(value) {
        return this.innerConverter.allocationSize(value.inner);
    }
}
exports.FfiConverterObjectAsError = FfiConverterObjectAsError;
//# sourceMappingURL=objects.js.map