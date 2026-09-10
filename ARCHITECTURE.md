# HomeKitDevice Architecture

## Overview

`HomeKitDevice` is a shared base class for accessory implementations. It sits between application-owned device data and either the standalone HAP-NodeJS runtime or the Homebridge runtime, giving each device type a common lifecycle, message bus, accessory helper layer, timer system, and optional EveHome history integration. Homebridge may expose HAP, Matter, or both.

**Version:** 2026.09.09
**Primary module:** `HomeKitDevice.js`  
**Consumers:** subclasses and host applications

---

## Position In The System

```
┌────────────────────────────────────────────────────────────┐
│          Homebridge (HAP + Matter) / HAP-NodeJS            │
└───────────────────────┬────────────────────────────────────┘
                        │
              ┌─────────▼─────────┐
              │  HomeKitDevice    │
              │  base class       │
              ├───────────────────┤
              │ accessory create  │
              │ lifecycle routing │
              │ static registry   │
              │ timers/history    │
              └─────────┬─────────┘
                        │ extends
┌───────────────────────┴────────────────────────────────────┐
│ Accessory subclasses                                        │
│ Switch, Sensor, Camera, Lock, Thermostat, etc.              │
└───────────────────────┬────────────────────────────────────┘
                        │ device data / SET / GET messages
              ┌─────────▼─────────┐
              │ Host application  │
              │ data + commands   │
              └───────────────────┘
```

`HomeKitDevice` is the accessory-facing runtime object. A host application creates subclass instances, sends updates, registers SET/GET handlers, and removes devices. Subclasses extend `HomeKitDevice` to define HAP services and characteristics, optional Matter endpoints and clusters, state mapping, and device behaviour.

---

## Core Responsibilities

`HomeKitDevice` owns:

- Homebridge and standalone HAP-NodeJS runtime detection
- optional Homebridge Matter API exposure without changing the lifecycle API
- deterministic HomeKit UUID generation from a configured namespace and serial number
- HAP accessory creation, restoration, publishing, unregistering, and unpublishing
- Homebridge Matter accessory restoration, registration, and unregistration
- a static device registry for cross-device message delivery
- static listener registration for external handlers
- lifecycle dispatch for add, update, remove, set, get, history, timer, shutdown, online, offline, and custom messages
- partial device-data merging and validation
- AccessoryInformation characteristic maintenance
- service and characteristic helper methods
- device-scoped timers with teardown cleanup
- optional EveHome history service integration
- accessory structure change detection and Homebridge `updatePlatformAccessories()` notification

## Runtime Backend Model

The constructor receives:

```js
new DeviceSubclass(accessory, api, deviceData)
```

It detects the runtime backend from the supplied API object:

- **Homebridge backend**
  - `api.hap` exists
  - `api.version` is numeric
  - `api.HAPLibraryVersion` is absent
  - exposes HAP through `this.hap`
  - exposes Matter through `this.matter` when `api.isMatterEnabled()` is true and `api.matter` is available
  - creates/restores Homebridge HAP platform accessories when HAP is requested
  - restores and registers Matter accessories assigned to `this.matterAccessory`
  - registers shutdown through `platform.on('shutdown')`

- **HAP-NodeJS backend**
  - `api.HAPLibraryVersion()` exists
  - `api.hap` is absent
  - exposes HAP through `this.hap` and never exposes Matter
  - creates and publishes standalone HAP accessories
  - registers shutdown through process signals

Matter is not a third backend. It is an optional protocol provided by the Homebridge runtime. Both protocols use the existing `ADD`, `UPDATE`, `SET`, `GET`, `REMOVE`, and `SHUTDOWN` message routes.

Shared static setup is configured by the host application before devices are created:

```js
HomeKitDevice.PLUGIN_NAME = 'example-homekit-namespace';
HomeKitDevice.PLATFORM_NAME = 'ExamplePlatform';
HomeKitDevice.LOGGER = log;
HomeKitDevice.EVEHOME = HomeKitHistory;
```

Subclasses may also expose static metadata:

```js
static TYPE = 'switch';
static VERSION = '2026.05.15';
```

`TYPE` identifies the device/accessory family for logs, diagnostics, and host-side grouping. `VERSION` identifies the subclass implementation version and is useful when setup logs or support output need to show which device module code is active.

---

## Device Identity And Registry

Every instance validates and clones `deviceData`, then generates a stable UUID:

```js
HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, serialNumber)
```

When HAP UUID generation is available, the generated value is based on:

```text
PLUGIN_NAME + '_' + serialNumber.toUpperCase()
```

The instance is then registered in a static registry:

```js
#deviceRegistry = Map<uuid, HomeKitDevice>
```

This registry enables:

- `HomeKitDevice.message(uuid, type, payload)` delivery
- shutdown broadcast to all active devices
- removal cleanup
- listener cleanup when devices are removed

The registry is intentionally private. Other modules communicate with devices through `HomeKitDevice.message()` rather than holding extra global references.

---

## Lifecycle Flow

### Add

```
host application creates subclass instance
        │
        ▼
device.add({ hapAccessoryName, hapCategory, enableHistory })
        │
        ├─ standalone HAP-NodeJS
        │    ├─ create the HAP accessory
        │    └─ configure pairing and publication data
        ├─ Homebridge HAP (default unless hapAccessoryName is null)
        │    └─ create/register or restore the HAP platform accessory
        ├─ HAP representation exists (Homebridge HAP or standalone HAP-NodeJS)
        │    ├─ update AccessoryInformation
        │    └─ create EveHome history service if requested
        ├─ dispatch HomeKitDevice.ADD
        ├─ Homebridge Matter representation exists
        │    └─ register the Matter accessory descriptor
        ├─ link/unlink EveHome characteristics
        ├─ log setup details
        ├─ dispatch forced HomeKitDevice.UPDATE
        └─ publish standalone HAP-NodeJS accessory
```

Subclasses build their representation during `onAdd()`. HAP subclasses use the existing service/characteristic methods. Matter subclasses assign `this.matterAccessory`. Homebridge defaults to HAP for compatibility; passing `{ hapAccessoryName: null }` explicitly requests Matter-only operation. Combined devices retain HAP if optional Matter registration fails, while setup fails when no requested representation can be registered.

### Update

```
host application sends HomeKitDevice.UPDATE
        │
        ▼
merge incoming partial data with stored deviceData
        │
        ├─ validate merged data
        ├─ update AccessoryInformation when a HAP representation exists
        ├─ update changed Matter metadata when a Matter representation exists
        ├─ emit ONLINE/OFFLINE if online state changed
        ├─ call onUpdate() only if changed or force=true
        └─ clone merged data into this.deviceData
```

The stored `deviceData` is a cloned snapshot, not a linked reference to caller-owned data.

### Remove

```
HomeKitDevice.REMOVE
        │
        ├─ call onRemove() and registered handlers
        ├─ clear device timers
        ├─ remove EventEmitter listeners
        ├─ remove static registry/listeners
        ├─ unregister or unpublish accessory
        └─ clear instance references
```

`REMOVE` is permanent accessory removal. It is not the same as shutdown.

### Shutdown

```
Homebridge shutdown or process signal
        │
        ▼
HomeKitDevice.shutdown()
        │
        └─ each registered device receives HomeKitDevice.SHUTDOWN
              ├─ deregister first to avoid duplicate shutdown
              ├─ call onShutdown() and registered handlers
              ├─ clear timers
              └─ remove EventEmitter listeners
```

`SHUTDOWN` is controlled runtime cleanup and does not unregister the accessory from HomeKit.

---

## Messaging Model

`HomeKitDevice` uses one message path for lifecycle, external handlers, timers, and custom events.

### Static Message API

```js
HomeKitDevice.message(uuid, type, message, ...args)
```

This does two different things depending on `message`:

- if `message` is a function, it registers a static listener for `uuid + type`
- if `message` is a non-plain object, it registers that object as a listener context
- otherwise it delivers the message to the registered device instance

Examples:

```js
HomeKitDevice.message(uuid, HomeKitDevice.SET, async (values) => {
  await writeDeviceValues(values);
});

HomeKitDevice.message(uuid, HomeKitDevice.UPDATE, listenerObject);
```

When an object context is registered, the handler method is inferred from the message type. For example, `HomeKitDevice.onUpdate` resolves to `context.onUpdate()`.

### Instance Message API

```js
await device.message(type, message, ...args)
```

Dispatch order is:

1. built-in lifecycle handling when the type has special semantics
2. matching instance hook, such as `onUpdate()`
3. registered static handlers for the device UUID and message type
4. generic `onMessage(type, message, ...args)` fallback

For lifecycle hook methods, `HomeKitDevice` walks the prototype chain. This allows both a subclass and a parent class to implement `onUpdate()` without requiring each subclass to call `super.onUpdate()`.

---

## Message Types

| Message | Purpose |
|---|---|
| `ADD` | accessory was created/restored and should build services |
| `UPDATE` | device data changed or initial forced update |
| `REMOVE` | permanent accessory removal |
| `SET` | HomeKit write from a characteristic |
| `GET` | HomeKit read from a characteristic |
| `HISTORY` | append EveHome/history entry and notify hooks |
| `SHUTDOWN` | controlled runtime shutdown |
| `TIMER` | internal timer fired |
| `ONLINE` | device online state changed to true |
| `OFFLINE` | device online state changed to false |
| custom | routed to matching `on<Type>()` or `onMessage()` |

Payload shape is not universal. `ADD`, `UPDATE`, `REMOVE`, and `SET` normalize missing payloads to `{}`. Other events may pass `undefined`, primitives, or structured objects.

---

## Accessory Structure Handling

Before message dispatch, HomeKitDevice snapshots the accessory service/characteristic structure when running under Homebridge. After dispatch it snapshots again.

If the structure changed, it calls:

```js
platform.updatePlatformAccessories([accessory])
```

This allows subclasses to add or remove optional services and characteristics during lifecycle handling without manually notifying Homebridge.

Characteristic value updates are still owned by subclass code. The structure snapshot only tracks service UUIDs, service subtypes, and characteristic UUIDs.

---

## Service And Characteristic Helpers

### `addService(serviceType, name, subType, eveOptions)`

Finds or creates a service on the accessory. If `eveOptions` are supplied, they are temporarily attached to the service and linked to EveHome after `onAdd()` completes.

### `removeService(serviceOrType, subType)`

Removes a service by instance or type/subtype lookup.

### `addCharacteristic(service, characteristicType, options)`

Ensures a characteristic exists and optionally applies:

- `props`
- `onSet`
- `onGet`
- `initialValue`

The helper respects optional characteristics and avoids adding duplicates.

### `removeCharacteristic(service, characteristicOrType)`

Removes an existing characteristic by instance or type without using `getCharacteristic()`, which can add optional characteristics as a side effect.

---

## Device Data Model

Device data must be a plain object. Full device data requires:

- `serialNumber`
- `softwareVersion`
- `description`
- `model`
- `manufacturer`

For HAP-NodeJS standalone usage, full data also requires:

- `hkPairingCode`
- `hkUsername`

Partial updates are allowed. Incoming updates are merged over the stored snapshot before validation:

```js
merged = {
  ...incoming,
  ...existingKeysNotPresentInIncoming,
}
```

Change detection normalises nested objects before comparison so object key order does not cause false updates. Undefined values are converted to a placeholder before JSON comparison.

---

## Timer Architecture

Timers are scoped to a device instance and keyed by a string handle.

Supported patterns:

- one-shot delay
- repeating interval
- delayed start then repeating interval

Timers can either:

- run a direct callback
- dispatch `HomeKitDevice.TIMER` to the device message system

Timer entries track:

```js
{
  delay,
  interval,
  timeout,
  intervalHandle,
  started,
  message,
  callback,
  running,
  cancelled,
}
```

The `running` flag prevents overlapping executions for the same timer. The `cancelled` flag lets in-flight async work finish without rescheduling a removed timer.

All timers are cleared on `REMOVE` and `SHUTDOWN`.

---

## EveHome History Integration

`HomeKitDevice` optionally creates a history service when:

- `HomeKitDevice.EVEHOME` is configured
- `enableHistory: true` is passed in the `add()` options
- a HAP representation exists, either under Homebridge or standalone HAP-NodeJS

EveHome history is therefore available to both HAP backends. It is not created for a Matter-only representation because EveHome history is implemented with HAP services and characteristics.

History writes are routed through:

```js
await device.history(targetService, entry, options)
```

`HomeKitDevice.HISTORY` processing:

- validates the target service, entry, and options
- adds a timestamp if one is missing
- compares with last history unless `options.force === true`
- skips duplicate entries when no meaningful fields changed
- calls `onHistory()` and registered history handlers

EveHome service linking is deferred until after `onAdd()` so subclasses can declare Eve options while building services.

---

## Extension Guidelines

When adding or refining subclasses:

1. Extend `HomeKitDevice` directly unless the device is intentionally built on another application-specific base subclass.
2. Build services and characteristics in `onAdd()`.
3. Apply state changes in `onUpdate(deviceData)`.
4. Use `this.set()` / registered `HomeKitDevice.SET` handlers for HomeKit writes.
5. Use `addTimer()` for device-scoped timing rather than unmanaged `setTimeout()` or `setInterval()`.
6. Use `history()` for EveHome-compatible history writes.
7. Keep lifecycle hooks focused on HomeKit state and service/characteristic behaviour.
8. Treat `message` payloads defensively because custom events are not guaranteed to be objects.
9. Avoid manually unregistering accessories from subclasses; use `HomeKitDevice.REMOVE`.

---

## Operational Notes

- Device instances are registry-owned until removed or shutdown.
- Static listeners are removed when the target device is removed or shut down.
- Accessory structure changes during message handling are automatically pushed to Homebridge.
- `SET` optimistically updates matching keys in `deviceData` after handlers run.
- `UPDATE` only invokes `onUpdate()` when data changed or `{ force: true }` is supplied.
- `ONLINE` and `OFFLINE` are derived from `deviceData.online` transitions during AccessoryInformation updates.
- `REMOVE` clears HomeKitDevice state aggressively so stale instances can be garbage collected.
