# HomeKitDevice Architecture

## Overview

`HomeKitDevice` is a shared base class for accessory implementations. It sits between application-owned device data and either the standalone HAP-NodeJS runtime or the Homebridge runtime, giving each device type a common lifecycle, message bus, accessory helper layer, timer system, and optional EveHome history integration. Homebridge may expose HAP, Matter, or both.

**Version:** 2026.10.18
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
- optional Homebridge HAP and Matter API exposure through the shared lifecycle API
- deterministic HomeKit UUID generation from a configured namespace and serial number
- HAP accessory creation, restoration, publishing, unregistering, and unpublishing
- Homebridge Matter accessory creation, restoration, registration, and unregistration
- a static device registry for cross-device message delivery
- static listener registration for external handlers
- lifecycle dispatch for add, update, remove, set, get, history, timer, shutdown, online, offline, and custom messages
- partial device-data merging and validation
- selected device-data restoration and Homebridge context persistence
- AccessoryInformation characteristic maintenance
- service and characteristic helper methods
- device-scoped timers with teardown cleanup
- optional EveHome history service integration
- bridged HAP cache change detection and Homebridge `updatePlatformAccessories()` notification

## Runtime Backend Model

The constructor receives:

```js
new DeviceSubclass(accessory, api, deviceData, persistedFields)
```

It detects the runtime backend from the supplied API object:

- **Homebridge backend**
  - `api.hap` exists
  - `api.version` is numeric
  - `api.HAPLibraryVersion` is absent
  - exposes HAP through `this.hap` when `api.isHapEnabled()` is not `false` (including older Homebridge versions without that method)
  - exposes Matter through `this.matter` when `api.isMatterEnabled()` is true and `api.matter` is available
  - restores a cached bridged HAP platform accessory into `this.accessory` during construction, or creates and registers a new bridged accessory before `onAdd()`; restored HAP accessories are not registered again
  - creates an external HAP platform accessory before `onAdd()` and publishes it only after the hook has completed its services and controllers
  - restores a cached Matter descriptor into `this.matterAccessory` during construction, or creates a minimum descriptor there before `onAdd()` when `matterDeviceType` is supplied
  - registers the completed Matter descriptor after `onAdd()`
  - registers shutdown through `platform.on('shutdown')`

- **HAP-NodeJS backend**
  - `api.HAPLibraryVersion()` exists
  - `api.hap` is absent
  - exposes HAP through `this.hap` and never exposes Matter
  - creates the standalone HAP accessory in `this.accessory` and publishes it after setup
  - registers shutdown through process signals

The optional `persistedFields` array declares selected `deviceData` fields stored under `context[this.constructor.PERSISTENCE_NAMESPACE]`, which defaults to `context.HomeKitDevice`. Initial constructor `deviceData` remains authoritative; the constructor fills only absent declared fields, preferring HAP when both cached representations contain a value. New Homebridge HAP and Matter representations receive independent copies before registration or publication. During `UPDATE`, changed declared values are written to each available context, with bridged HAP persistence handled by the existing accessory cache snapshot and Matter persistence batched with metadata updates. Subclasses may override `PERSISTENCE_NAMESPACE`, but must keep it stable to retain access to existing cache data. Standalone and externally published HAP accessories do not provide durable context persistence.

Matter is not a third backend. It is an optional protocol provided by the Homebridge runtime. Both protocols use the existing `ADD`, `UPDATE`, `SET`, `GET`, `REMOVE`, and `SHUTDOWN` message routes.

Shared static setup is configured by the host application before devices are created:

```js
HomeKitDevice.PLUGIN_NAME = 'example-homekit-namespace';
HomeKitDevice.PLATFORM_NAME = 'ExamplePlatform';
HomeKitDevice.LOGGER = log;
HomeKitDevice.EVEHOME = HomeKitHistory;
```

Subclasses may also configure device-specific static fields:

```js
static TYPE = 'switch';
static VERSION = '2026.05.15';
static PERSISTENCE_NAMESPACE = 'SwitchDevice';
```

`TYPE` identifies the device/accessory family for logs, diagnostics, and host-side grouping. `VERSION` identifies the subclass implementation version and is useful when setup logs or support output need to show which device module code is active. `PERSISTENCE_NAMESPACE` selects the stable Homebridge context key used by that subclass.

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

The constructor rejects an already-registered UUID before adding the instance to the static registry. This enforces one registered instance per device identity rather than silently replacing a live owner:

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
device.add({ hapAccessoryName, hapCategory, externalPublish, matterDeviceType, enableHistory })
        │
        ├─ standalone HAP-NodeJS
        │    ├─ create the HAP accessory
        │    └─ configure pairing and publication data
        ├─ Homebridge HAP (restored, or newly created unless hapAccessoryName is null)
        │    ├─ create or restore the HAP platform accessory
        │    ├─ seed declared context fields on a new representation
        │    ├─ register a new bridged accessory before onAdd()
        │    └─ create an external HAP platform accessory without publishing it yet
        ├─ HAP representation exists (Homebridge HAP or standalone HAP-NodeJS)
        │    ├─ update AccessoryInformation
        │    └─ create EveHome history service if requested
        ├─ Homebridge Matter requested or restored
        │    ├─ create/restore the minimum Matter descriptor
        │    └─ seed declared context fields on a new descriptor
        ├─ dispatch HomeKitDevice.ADD
        │    ├─ subclass completes HAP services and Matter clusters/handlers
        │    └─ link/unlink EveHome characteristics
        ├─ persist bridged HAP metadata after onAdd()
        ├─ register the completed Matter accessory descriptor
        ├─ dispatch forced HomeKitDevice.UPDATE
        ├─ publish external Homebridge or standalone HAP-NodeJS accessory
        └─ log setup details
```

When `matterDeviceType` is supplied, the base class creates the minimum Matter descriptor before `onAdd()`. Matter subclasses complete that existing `this.matterAccessory` with clusters, handlers, parts, and state during the shared hook; registration follows only after the descriptor is complete. Homebridge defaults to HAP for compatibility; passing `{ hapAccessoryName: null }` explicitly suppresses HAP creation. Combined devices retain HAP if optional Matter registration fails, while setup fails when no requested representation can be registered.

`hapAccessoryName: null` does not discard a HAP accessory already restored through the constructor. The option suppresses only new HAP creation; the host must omit a cached HAP representation when intentionally migrating a device to Matter-only exposure.

When Matter is requested, the host platform must call `add()` from or after Homebridge's `didFinishLaunching` event. Homebridge rejects registration before its Matter manager is ready. The rejection is logged and clears `this.matterAccessory`, leaving a dual-protocol device as HAP-only and causing Matter-only setup to fail.

Passing `{ externalPublish: true }` changes only the Homebridge HAP publication boundary. The HAP platform accessory still exists in `this.accessory` before `onAdd()`, but it is published independently after the hook and forced initial update instead of being registered with the bridge beforehand. Standalone HAP-NodeJS already publishes independently and ignores this option.

Lifecycle hooks are shared across protocols and are not called once per representation. A subclass must therefore check `this.accessory !== undefined` before HAP-specific work and `this.matterAccessory !== undefined` before Matter-specific work in `onAdd()`, `onUpdate()`, and other hooks. Either property may be absent on HAP-only, Matter-only, or partially available Homebridge runtimes.

`onAdd()` is dispatched only when at least one of those representations is available after creation, restoration, and HAP information validation. A failed HAP registration cannot therefore invoke subclass setup with both properties undefined.

### Update

```
host application sends HomeKitDevice.UPDATE
        │
        ▼
validate supplied fields, then claim state ownership
        │
        ├─ merge incoming partial data with stored deviceData
        ├─ validate merged data
        ├─ update AccessoryInformation when a HAP representation exists
        ├─ update changed Matter metadata when a Matter representation exists
        ├─ update and persist declared context fields
        ├─ emit ONLINE/OFFLINE if online state changed
        ├─ call onUpdate() only if changed or force=true
        └─ clone merged data into this.deviceData
```

The stored `deviceData` is a cloned snapshot, not a linked reference to caller-owned data. UPDATE commits valid incoming state even when an update hook or its nested work fails; its promise still rejects with the failure. SET instead skips its automatic commit after a handler or nested-operation failure.

### Remove

```
HomeKitDevice.REMOVE
        │
        ├─ call onRemove() and registered handlers
        ├─ clear device timers
        ├─ remove EventEmitter listeners
        ├─ remove static registry/listeners
        ├─ unregister bridged HAP and Matter representations
        ├─ unpublish standalone HAP-NodeJS
        ├─ leave external Homebridge HAP published until shutdown
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
              ├─ mark lifecycle state to avoid duplicate shutdown
              ├─ call onShutdown() and registered handlers
              ├─ clear timers
              ├─ remove EventEmitter listeners
              └─ deregister after queued work settles
```

`SHUTDOWN` is controlled runtime cleanup and does not unregister the accessory from HomeKit.

Runtime events and external static shutdown calls submit requests through the existing device lifecycle queues. Registry entries remain until queued shutdown work settles, including independently started instance cleanup. Repeated requests wait behind earlier work, and lifecycle state prevents duplicate hooks. External broadcasts recheck the registry after each batch to include devices registered while cleanup was pending. Hook-originated broadcasts perform one batch using normal queue admission so they cannot wait for their own registry entry to clear; active ancestors are checked when a hook retains a finished child's async context.

For standalone HAP-NodeJS, an admitted shutdown request marks publication as stopped before joining the lifecycle queue. Setup hooks and writes remain ordered, but a pending publication wait releases its ADD slot immediately. Cancellation starts unpublishing independently of device hooks; late publication settlement repeats cleanup using the captured accessory. The underlying publisher is not cancellable, so this provides eventual teardown rather than a guarantee against briefly advertising after cancellation. REMOVE continues to wait for standalone publication as before.

Standalone unpublishing uses one per-device promise tail shared by cancellation, late publication settlement, and REMOVE. Publication settlement is inspected after checking shutdown intent so a concurrent rejection cannot bypass cancellation cleanup.

---

## Messaging Model

`HomeKitDevice` uses one message path for lifecycle, external handlers, timers, and custom events.

Each instance orders every externally submitted message through a promise tail. The complete add() operation owns one slot through descriptor creation, registration, initial UPDATE, and publication, using internal dispatch directly within that slot. Its initial UPDATE merges an empty payload with current state rather than submitting a full snapshot. The ordering boundary includes metadata persistence, hooks, state commits, and bridged HAP cache writes. UPDATE therefore builds its merged snapshot only after preceding lifecycle work completes. Caller rejections are preserved while the tail recovers so later submissions can proceed.

REMOVE and SHUTDOWN stop subsequent dispatch; REMOVE remains available after SHUTDOWN for protocol cleanup. A device-scoped async context admits all nested dispatch within the owning queue slot. Each hook orders its own child submissions; the root waits for every descendant before releasing its slot and propagates descendant failures. State and resource handlers claim ownership until their commit or cleanup completes; descendants cannot take overlapping ownership. Ordinary handlers can submit nested state changes without a message whitelist in the queue. Recursive routes and returns through another device to an active ancestor reject to prevent deadlocks. Outstanding cross-device submissions are tracked as potential waits on active contexts; graph traversal rejects a submission that closes a cycle, including independently started dispatches. Counts retain dependencies when several submissions target the same device, and completion releases them.

The context becomes inactive on completion so asynchronous work created by a hook can submit later work. HomeKitDevice timer invocation exits the inherited async context before invoking a callback or TIMER dispatch, making timer updates independent submissions even during a suspended hook. GET, TIMER, HISTORY, and custom types use the same queue. Online/offline notifications dispatch internally within the UPDATE slot. Nested work uses the same ownership mechanism for every admitted message type; no history-specific scheduling or command state reconciliation is needed. Command handlers must finish before submitting follow-up state messages; awaiting an UPDATE behind the current command is an invalid dependency.

### Static Message API

Private listener storage uses a Map keyed by UUID, containing a Map keyed by message type. Each type retains an ordered array of handler/context pairs; registration deduplicates those pairs, and REMOVE or SHUTDOWN deletes the device's listener Map.

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

Handlers signal failure by throwing or rejecting. Each handler error is logged, remaining hooks and listeners run, and required REMOVE or SHUTDOWN cleanup completes before dispatch rejects with the first handler error. Errors in dispatch processing also reject. Instance messages, UUID delivery, and public wrappers forward the rejection; callers must use `try/catch` or promise rejection handling. GET results such as `false` remain valid successful values. Hook completion collects failures from its nested operations, including ignored submissions, before any parent commit. SET ignores handler return values and skips its automatic data update after a handler or nested-operation failure. UPDATE retains its existing commit-after-hook-failure behaviour.

Timer execution catches dispatch rejections to retain cleanup and repeat scheduling. Global shutdown dispatches notifications independently and waits for all results to settle, so a stalled queue or logged rejection cannot delay cleanup of other devices.

---

## Message Types

| Message | Purpose |
|---|---|
| `ADD` | protocol representations exist; build HAP services and complete Matter clusters, handlers, parts, and state |
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

Payload shape is not universal. ADD and REMOVE normalise only missing or null payloads to `{}`. UPDATE and SET require plain objects and ignore invalid payloads. Other events may pass `undefined`, primitives, or structured objects.

The `update()`, `set()`, and `history()` wrappers return their instance-message promise directly; they do not add async wrappers or validate before submission. UPDATE and SET validate in their dispatch branches before claiming state ownership or invoking hooks. HISTORY validates in its own branch before storage and hook invocation. Direct instance messages use the same validation. Invalid payloads resolve to `undefined` when dispatched, while queue admission can reject recursive or cyclic requests before payload validation.

---

## HAP Accessory Cache Handling

Before message dispatch, HomeKitDevice snapshots the bridged HAP accessory data that it manages in the Homebridge cache. After dispatch it snapshots again.

If the snapshot changed, it calls:

```js
platform.updatePlatformAccessories([accessory])
```

This allows subclasses to add or remove optional services and characteristics during lifecycle handling without manually notifying Homebridge, and persists changes to declared `context` fields. A failed cache write is retried once within the same dispatch; a second failure rejects the message. Live HAP mutations are not rolled back. Setup also persists bridged HAP metadata after onAdd(), because its initial metadata changes precede the ADD cache snapshot.

The snapshot tracks the display name, AccessoryInformation values, service UUIDs and subtypes, characteristic UUIDs, and the namespace selected by `PERSISTENCE_NAMESPACE`. Operational characteristic values remain owned by subclass code and are not part of this cache comparison.

---

## HAP Service/Characteristic And Matter Cluster Helpers

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
For finite numeric initial values, the helper temporarily clears the owned instance's current value during `setProps()`, restoring it in `finally` before the normal service update. HAP therefore validates the initial value against final props without first clamping the construction default. Change events retain the previous value; validation remains owned by HAP. Other calls retain existing behavior, and shared prototypes remain untouched.

### `removeCharacteristic(service, characteristicOrType)`

Removes an existing characteristic by instance or type without using `getCharacteristic()`, which can add optional characteristics as a side effect.

### `addMatterCluster(clusterName, options)`

Ensures a root Matter cluster exists before registration and optionally applies:

- `initialState` - initial cluster attributes, corresponding to `initialValue` for a HAP characteristic
- `handlers` - Matter command names mapped to their handler functions

Repeated calls merge initial state and command handlers with the existing cluster declaration. The helper returns the configured
initial state, or `undefined` when the cluster name or Matter descriptor is unavailable. Later operational state changes use
Matter's `updateAccessoryState()` API.

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

Partial updates are allowed. UPDATE validates the supplied fields, merges them over the stored snapshot, then strictly validates the complete result. Fields supplied as `undefined` retain their stored value:

```js
merged = {
  ...incoming,
  ...existingKeysNotPresentInIncoming,
}
```

Change detection uses Node.js's built-in deep strict equality to preserve value types, distinguish undefined from the string 'undefined', and ignore object key order while preserving array order. HAP cache snapshots clone context and characteristic values so later mutations cannot change the earlier snapshot.

Declared persisted fields are copied into the namespace selected by `PERSISTENCE_NAMESPACE`. Constructor values override cached values; HAP is the first restore source for a missing field and Matter is the fallback. `UPDATE` keeps available HAP and Matter contexts synchronised without sharing object references. A failed Matter cache update restores its previous descriptor context so a later update can retry.

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

Creation and reset return `false` once REMOVE or SHUTDOWN starts, including during teardown hooks and resumed callbacks. Existing timers are cleared after teardown hooks finish. Delay-only and delayed repeating timers share the initial timeout path; interval-only timers start directly. All schedules share registry insertion, and delayed repetition checks cancellation and registry ownership before starting its interval.

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
- replaces a timestamp that is not a finite number with the current epoch time in seconds
- compares with last history unless `options.force === true`
- skips duplicate entries when no meaningful fields changed
- awaits the history writer with a finite numeric time gap when supplied
- calls `onHistory()` and registered history handlers unless the writer returns `false` (legacy `undefined` results are treated as accepted)

EveHome service linking is deferred until after `onAdd()` so subclasses can declare Eve options while building services.

---

## Extension Guidelines

When adding or refining subclasses:

1. Extend `HomeKitDevice` directly unless the device is intentionally built on another application-specific base subclass.
2. In every lifecycle hook, guard HAP-specific work with `this.accessory !== undefined` and Matter-specific work with `this.matterAccessory !== undefined`; never assume both representations exist.
3. Build HAP services and characteristics, and complete Matter clusters, handlers, parts, and initial state, in `onAdd()`.
4. Apply state changes in `onUpdate(deviceData)` to each representation that exists.
5. Use `this.set()` / registered `HomeKitDevice.SET` handlers for HomeKit writes.
6. Use `addTimer()` for device-scoped timing rather than unmanaged `setTimeout()` or `setInterval()`.
7. Use `history()` for EveHome-compatible history writes.
8. Keep lifecycle hooks focused on protocol state and representation behaviour.
9. Treat `message` payloads defensively because custom events are not guaranteed to be objects.
10. Avoid manually unregistering accessories from subclasses; use `HomeKitDevice.REMOVE`.

---

## Operational Notes

- Device instances are registry-owned until removed or shutdown.
- Static listeners are removed when the target device is removed or shut down.
- Bridged HAP structure, metadata, and declared context changes during message handling are automatically pushed to Homebridge.
- `SET` updates matching keys in `deviceData` after all hooks and registered handlers complete without throwing or rejecting. A trapped handler failure skips this automatic update.
- `UPDATE` only invokes `onUpdate()` when data changed or `{ force: true }` is supplied.
- `ONLINE` and `OFFLINE` are derived from `deviceData.online` transitions during shared metadata updates, including Matter-only devices.
- `REMOVE` clears HomeKitDevice state aggressively so stale instances can be garbage collected.
