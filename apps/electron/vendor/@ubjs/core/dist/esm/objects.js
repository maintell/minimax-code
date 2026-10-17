/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */
import { AbstractFfiConverterByteArray, FfiConverterUInt64, } from "./ffi-converters.js";
import { UniffiHandleMap } from "./handle-map.js";
import { UniffiThrownObject } from "./errors.js";
/**
 * Marker interface for all `interface` objects that cross the FFI.
 * Reminder: `interface` objects have methods written in Rust.
 *
 * This typesscript interface contains the unffi methods that are needed to make
 * the FFI work. It should shrink to zero methods.
 */
export class UniffiAbstractObject {
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
const pointerConverter = FfiConverterUInt64;
const dummyPointer = BigInt("0");
/**
 * An FfiConverter for an object.
 */
export class FfiConverterObject {
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
/// An FfiConverter for objects with callbacks.
export class FfiConverterObjectWithCallbacks extends FfiConverterObject {
    handleMap;
    constructor(factory, handleMap = new UniffiHandleMap()) {
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
/// Due to some mismatches in the ffi converter mechanisms, errors are a RustBuffer holding a pointer
export class FfiConverterObjectAsError extends AbstractFfiConverterByteArray {
    typeName;
    innerConverter;
    constructor(typeName, innerConverter) {
        super();
        this.typeName = typeName;
        this.innerConverter = innerConverter;
    }
    read(from) {
        const obj = this.innerConverter.read(from);
        return new UniffiThrownObject(this.typeName, obj);
    }
    write(value, into) {
        const obj = value.inner;
        this.innerConverter.write(obj, into);
    }
    allocationSize(value) {
        return this.innerConverter.allocationSize(value.inner);
    }
}
//# sourceMappingURL=objects.js.map