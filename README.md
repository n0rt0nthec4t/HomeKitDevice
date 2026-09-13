# HomeKitDevice

Base class for accessories using standalone HAP-NodeJS or Homebridge with HAP and optional Matter.
Provides internal device tracking, metadata validation, lifecycle management, message routing, and optional EveHome-compatible history logging.

---

## Overview

All lifecycle transitions, internal events, and inter-device communication flow through the unified `message()` dispatch system.  
This ensures consistent execution ordering, prototype chain hook resolution, and centralised error handling across all device types.

The `HomeKitDevice` module provides:

- Lifecycle hooks (`onAdd`, `onUpdate`, `onRemove`, `onShutdown`, `onSet`, `onGet`, `onMessage`, `onHistory`, `onTimer`)
- Static and instance `.message()` routing
- Public wrapper methods (`add()`, `update()`, `remove()`, `shutdown()`, `get()`, `set()`, `history()`)
- Internal named timer system (`addTimer`, `removeTimer`, `hasTimer`)
- Safe service and characteristic helpers (`addService`, `removeService`, `addCharacteristic`, `removeCharacteristic`)
- EveHome-compatible history support (`history`)
- Internal device registry for UUID-based lookup and messaging
- Selected `deviceData` persistence through Homebridge HAP and Matter accessory context

Supports Homebridge plugins using `api.hap`, optional Homebridge 2.x `api.matter`, and standalone HAP-NodeJS environments.

---

## Construction

Device subclasses use the base constructor signature:

```js
HomeKitDevice.PLUGIN_NAME = 'homebridge-example';
HomeKitDevice.PLATFORM_NAME = 'ExamplePlatform';
HomeKitDevice.LOGGER = log;
let device = new MyDevice(accessory, api, deviceData, ['configuredName', 'inputSource']);
```

The optional `accessory` argument may be a Homebridge cached HAP accessory, a cached Matter accessory, or an array containing both. The `api` argument is the Homebridge platform API or a HAP-NodeJS API object. The `deviceData` object must contain the required fields listed below.

The optional `persistedFields` array declares selected `deviceData` fields to store in Homebridge accessory context. It must contain unique, non-empty field names, and persisted values should be JSON-serialisable. The default location is `context.HomeKitDevice`, selected by static `PERSISTENCE_NAMESPACE`. Initial constructor data takes precedence, while absent declared fields are restored from cached HAP and then Matter context. Undeclared cached fields are ignored. New Homebridge representations receive initial values before registration or publication, and later changes are written during `UPDATE`. Bridged HAP and Matter use their respective cache APIs; standalone and externally published HAP do not provide durable context persistence. Subclasses may override `PERSISTENCE_NAMESPACE`, but should keep the value stable so existing cache data remains accessible.

Under Homebridge, `this.hap` references `api.hap` unless `api.isHapEnabled()` explicitly returns `false`. When `api.isMatterEnabled()` returns `true` and `api.matter` is available, `this.matter` references `api.matter`; otherwise it is `undefined`. The presence of `api.matter` alone does not enable Matter for a bridge. Standalone HAP-NodeJS instances never expose Matter.

Set `HomeKitDevice.LOGGER` before creating devices to make `this.log` available inside subclasses. The logger is shared rather than passed through each subclass constructor. Any supported logging functions it provides are attached to `this.log`; missing functions are left undefined, so subclasses should call them with optional chaining.

---

## Subclassing Example

```js
import HomeKitDevice from './HomeKitDevice.js';

export default class MyDevice extends HomeKitDevice {
  static TYPE = 'MyDevice';
  static VERSION = '2025.06.18';

  async onAdd() {
    this.myService = this.addService(this.hap.Service.Switch);
    this.addCharacteristic(this.myService, this.hap.Characteristic.On, {
      onSet: (value) => this.setSwitch(value),
      onGet: () => this.getSwitch(),
      props: { minStep: 1 },
      initialValue: false,
    });
  }

  async onUpdate(deviceData) {
    this.log?.debug?.('Updated deviceData', deviceData);
  }

  async onSet(message) {
    this.setSwitch(message);
  }

  async onRemove() {
    this.log?.info?.('Device removed');
  }

  async onMessage(type, message) {
    this.log?.debug?.('Received custom message', type, message);
  }

  onHistory(target, entry) {
    this.log?.debug?.('History logged for %s: %o', target.displayName, entry);
  }

  setSwitch(value) {
    this.log?.info?.('Switch set to:', value);
  }

  getSwitch() {
    return true;
  }
}
```

---

## Required `deviceData` Fields

Each device must include:

| Field            | Description                          |
|------------------|--------------------------------------|
| `serialNumber`   | Unique identifier for the device     |
| `softwareVersion`| Firmware or software version         |
| `description`    | User-visible description             |
| `manufacturer`   | Manufacturer name                    |
| `model`          | Model number                         |

---

### For Standalone HAP-NodeJS Only

Required in addition to the above:

| Field           | Description                                         |
|----------------|-----------------------------------------------------|
| `hkUsername`   | HomeKit MAC-style address (e.g. `11:22:33:44:55:66`) |
| `hkPairingCode`| HomeKit setup code (e.g. `123-45-678`)               |

---

## Homebridge Matter

Matter uses the existing lifecycle and message routing API; it does not add protocol-specific lifecycle hooks. Pass `matterDeviceType` to `add()` to request a new Matter representation. Before `onAdd()` runs, the base class creates `this.matterAccessory` with its device type, deterministic identity, common metadata, and context. The subclass then adds clusters, handlers, parts, and initial state during `onAdd()`. The completed descriptor is registered afterward through `api.matter.registerPlatformAccessories()`.

Homebridge platforms must call `add()` from or after `didFinishLaunching` when Matter is requested. Homebridge rejects Matter registration before its Matter manager is ready. `HomeKitDevice` logs that rejection and removes `this.matterAccessory`; a dual-protocol device continues as HAP, while Matter-only setup fails.

Homebridge retains HAP as the default, including existing calls that omit all `add()` options. Set `hapAccessoryName` to `null` explicitly to suppress creation of a new HAP representation and request a Matter-only device:

```js
await device.add({
  hapAccessoryName: null,
  matterDeviceType: this.matter.deviceTypes.OnOffSwitch,
});
```

A HAP accessory already restored through the constructor remains active even when `hapAccessoryName` is `null`; the option controls creation and does not remove cached representations.

HAP `AccessoryInformation` and EveHome history setup run whenever `this.accessory` exists, covering both Homebridge HAP and standalone HAP-NodeJS. They are skipped only for Matter-only devices because a Matter accessory does not contain HAP services. During the normal `UPDATE` route, shared device information is synchronised to both representations: `description` becomes the Matter `displayName`, and manufacturer, model, serial number, and software version are mapped to their corresponding Matter metadata fields. Changed Matter metadata and declared context fields are persisted with one `this.matter.updatePlatformAccessories()` call.

Matter command handlers should route device writes through the existing `set()` or `message(HomeKitDevice.SET, ...)` flow. Operational device state continues through `update()` and `onUpdate()`, where a subclass can call `this.matter.updateAccessoryState()` directly. Standalone HAP-NodeJS continues to require the HAP name and category.

When `remove()` is called, bridged HAP and Matter representations are unregistered through their respective Homebridge APIs, while standalone HAP-NodeJS accessories are unpublished. Homebridge currently owns the lifetime of published external HAP accessories and does not expose a corresponding public unpublish API, so they remain published until Homebridge shuts down. Existing HAP-only subclasses require no changes.

For combined exposure, a Matter registration failure is logged and the registered HAP representation remains available. Matter-only setup never reports success without a registered Matter representation; failed or rejected requests return `false` or `undefined`.

The host Homebridge platform should pass objects restored by `configureAccessory()` and `configureMatterAccessory()` through the constructor `accessory` argument. Pass one object for a single cached representation and combine both objects in one array for a dual-protocol device.

---

## Public Methods

### `add(options?)`

Creates and registers the representations requested by the device, then returns `true` when at least one valid representation is available. Failed or rejected requests return `false` or `undefined`. `options` is a plain object with these fields:

- `hapAccessoryName` – HAP accessory name. Set this to `null` for Matter-only operation.
- `hapCategory` – HAP accessory category, passed to Homebridge and required by standalone HAP-NodeJS.
- `externalPublish` – When `true`, publish a new Homebridge HAP accessory independently after `onAdd()` and the forced initial update instead of registering it with the bridge. Defaults to `false` and is ignored by standalone HAP-NodeJS.
- `matterDeviceType` – Homebridge Matter endpoint type. When supplied, the minimum Matter descriptor is created before `onAdd()` and registered after the hook completes it.
- `enableHistory` – Whether to create EveHome history for a HAP representation. Defaults to `false`.

```js
await device.add({
  hapAccessoryName: 'Switch',
  hapCategory: this.hap.Categories.SWITCH,
  matterDeviceType: this.matter?.deviceTypes.OnOffSwitch,
  enableHistory: true,
});
```

External HAP accessories, such as televisions that must be paired separately, are fully configured before Homebridge publishes them:

```js
await device.add({
  hapAccessoryName: 'Television',
  hapCategory: this.hap.Categories.TELEVISION,
  externalPublish: true,
});
```

---

### `addService(service, name?, subtype?, eveOptions?)`

Adds the specified HAP service to the accessory if not already present.  
Returns the existing or newly created service instance.

---

### `removeService(service, subtype?)`

Removes the specified HAP service from the accessory if present.  
Accepts either an existing service instance or a HAP service type with an optional subtype. Returns `true` when a service was removed.

---

### `addCharacteristic(service, characteristic, options)`

Binds a characteristic to the given service with handler and property options.

Supported `options`:

- `onSet(value)` – Called when HomeKit sets the characteristic value
- `onGet()` – Called when HomeKit reads the characteristic value
- `props` – Defines characteristic metadata (`minStep`, `unit`, `minValue`, `maxValue`, `validValues`, etc.)
- `initialValue` – Value to initialise immediately

---

### `removeCharacteristic(service, characteristic)`

Removes the specified characteristic from a HAP service if present.  
Accepts either an existing characteristic instance or a HAP characteristic type. Returns `true` when a characteristic was removed.

---

### `history(target, entry, options?)`

Adds a structured entry to Eve-compatible history storage.

- Automatically sets `entry.time` to current epoch if missing
- Skips redundant entries unless `options.force === true`
- Uses `options.timegap` (in seconds) to suppress entries too close together
- Calls `.onHistory(target, entry, options)` if implemented by the subclass

```js
await this.history(this.myService, {
  status: 1,
  temperature: 22.5,
}, {
  timegap: 60,
  force: false,
});
```

### `set(values, ...args)`

Validates a plain-object payload and dispatches it through the `SET` route to `onSet()` and registered handlers. Matching existing keys in `deviceData` are updated after the handlers complete.

### `get(values, ...args)`

Dispatches a request through the `GET` route to `onGet()` and registered handlers, and returns their result.

### `remove()`

Dispatches the permanent `REMOVE` lifecycle route. Hooks run before timers, listeners, registry entries, protocol registrations, and instance references are cleaned up.

### `shutdown()`

Triggers the `.SHUTDOWN` lifecycle message.  
Used during platform shutdown to allow devices to perform cleanup.

The static `HomeKitDevice.shutdown()` broadcasts this route to every registered device; `device.shutdown()` targets one instance.

All active timers and internal resources are automatically released during shutdown.

> **Note:**  
> `.REMOVE` permanently unregisters the accessory from the platform.  
> `.SHUTDOWN` is used during controlled runtime shutdown and does not imply device removal.
> Standalone HAP-NodeJS applications should still handle their own process exit policy after shutdown has completed, such as calling `process.exit()` from their signal handler when appropriate.

### `update(deviceData, ...args)`

Applies a partial or full update to the device’s internal state.

- Merges incoming data with existing `deviceData`
- Performs validation on supplied fields
- Triggers `.onUpdate(deviceData)` only if changes are detected  
  (or when `{ force: true }` is passed)
- Automatically updates shared HAP and Matter metadata
- Persists changed declared fields to bridged HAP and Matter accessory context

```js
await this.update({
  description: 'New Name',
  online: true,
});
```

---

## Messaging

Send a message to any registered device using its UUID:

```js
HomeKitDevice.message(uuid, HomeKitDevice.SET, value);
```

Known message types route to their matching lifecycle hook, such as `SET` to `onSet(message)`. Custom types fall back to `onMessage(type, message)`.

> **Important:**  
> The `message` payload is not guaranteed to be an object.
>
> - Lifecycle events (`ADD`, `UPDATE`, `SET`, `REMOVE`) will normalise `message` to an object.
> - Other messages (e.g. `ONLINE`, `OFFLINE`, custom events) may pass `undefined`, primitives, or structured objects.
>
> Handlers should not assume `message` is always an object:
>
> ```js
> async onMessage(type, message) {
>   if (type === HomeKitDevice.ONLINE) {
>     // message may be undefined
>     return;
>   }
>
>   if (type === SomeCustomEvent && typeof message === 'object' && message !== null) {
>     // safe to use message fields
>   }
> }
> ```

---

## Internal Timer System

`HomeKitDevice` provides a structured internal timer system that integrates with the lifecycle and message routing system.

Timers are identified by a string handle and may:

- Fire once after a delay
- Fire repeatedly at an interval
- Fire once after a delay and then repeat

Timers may either:
- Execute a direct callback (if provided)
- Dispatch a `HomeKitDevice.TIMER` lifecycle message (if no callback is provided)

> **Note:** Timer callbacks execute non-blocking. Even if a callback or message handler takes time to complete, it won't delay the next interval firing.

All timers are automatically cleaned up during `.SHUTDOWN` after shutdown hooks complete.
Timers are device-scoped and are also released during `.REMOVE`.

### `addTimer(timerHandle, options?, callback?)`

Registers a timer.

Supported `options`:

| Option      | Description |
|------------|------------|
| `delay`     | Milliseconds before first fire (optional) |
| `interval`  | Milliseconds between repeated fires (optional) |
| `reset`     | If `true`, replaces existing timer with same handle |
| `message`   | Object payload passed to `onTimer()` or callback |

Examples:

```js
// Fire once after 60 seconds
this.addTimer('motion', { delay: 60000 });

// Repeat every 30 seconds
this.addTimer('heartbeat', { interval: 30000 });

// Fire once after 10s, then every 60s
this.addTimer('poll', { delay: 10000, interval: 60000 });

// Extend an existing cooldown timer
this.addTimer('motion', { delay: 60000, reset: true });
```

### `removeTimer(timerHandle)`

Stops and removes a timer by handle.  
Safe to call multiple times.

```js
this.removeTimer('motion');
```

### `hasTimer(timerHandle)`

Returns true if a timer with the given handle is currently registered.

```js
if (this.hasTimer('motion') === true) {
  this.log?.debug?.('Motion cooldown active');
}
```

### Other utilities

- `postSetupDetail(message, ...args)` queues a formatted setup-log entry. A final recognised log-level string selects its level.
- `HomeKitDevice.generateUUID(pluginName, api, serialNumber)` generates the deterministic device UUID and throws when its inputs or the runtime UUID API are invalid.
- `HomeKitDevice.makeValidHKName(name)` removes characters that HomeKit names do not accept and falls back to `Unknown Device` when a string becomes empty.
- `device.uuid` exposes the instance's generated UUID as a read-only getter.

---

## Lifecycle Hooks

| Method                      | Called when... |
|-----------------------------|----------------|
| `onAdd(message)`            | A `.ADD` message is received when the accessory is initialised |
| `onUpdate(deviceData)`      | A `.UPDATE` message updates the device configuration/state |
| `onRemove(message)`         | A `.REMOVE` message unregisters the device permanently |
| `onShutdown(message)`       | A `.SHUTDOWN` message is received during platform shutdown |
| `onSet(message)`            | A `.SET` lifecycle message applies new values |
| `onGet(message)`            | A `.GET` message queries current values/state |
| `onTimer(message)`          | A `.TIMER` message is dispatched by internal timers |
| `onHistory(target, entry, options)` | After a history entry is successfully logged |
| `onMessage(type, message)`  | A message not handled by known types |

---

## Lifecycle Hook Resolution

When a lifecycle message such as `.ADD`, `.UPDATE`, or `.REMOVE` is dispatched, the `HomeKitDevice` class now walks the prototype chain of the target instance to invoke all defined hook methods.

This means any `onAdd()`, `onUpdate()`, `onRemove()`, etc. methods defined in parent classes (such as base device types or mixins) will also be called, in order from the instance itself up the prototype chain.

Each hook is only invoked once per `(handler, context)` pair to avoid duplicate calls when the same function appears multiple times along the chain.

This enables shared logic across subclasses without needing to manually call `super.onUpdate()` or similar.

For example:

- If both `Base` and `Extended` define an `onUpdate()` method and `Extended` extends `Base`, both methods will be called.
- Ordering is guaranteed: subclass first, parent classes later.

---

## Static Constants

Public static configuration and message constants include:

| Constant                  | Description                                                      |
|---------------------------|------------------------------------------------------------------|
| `HomeKitDevice.ADD`       | Sent during accessory initialisation (`onAdd`)                   |
| `HomeKitDevice.UPDATE`    | Sent to apply updated device data (`onUpdate`)                   |
| `HomeKitDevice.REMOVE`    | Sent to unregister the accessory (`onRemove`)                    |
| `HomeKitDevice.SET`       | Sent to apply new values (`onSet`)                               |
| `HomeKitDevice.GET`       | Sent to query device state (`onGet`)                             |
| `HomeKitDevice.MESSAGE`   | Base message name used by the generic `onMessage` route          |
| `HomeKitDevice.HISTORY`   | Sent when a history entry is logged (`onHistory`)                |
| `HomeKitDevice.SHUTDOWN`  | Sent during controlled shutdown (`onShutdown`)                   |
| `HomeKitDevice.TIMER`     | Sent when an internal timer fires (`onTimer`)                    |
| `HomeKitDevice.ONLINE`    | Sent when device transitions to online state                     |
| `HomeKitDevice.OFFLINE`   | Sent when device transitions to offline state                    |
| `HomeKitDevice.PERSISTENCE_NAMESPACE` | Context key used for declared persisted fields (default `HomeKitDevice`) |
| `HomeKitDevice.PLUGIN_NAME` | Plugin identifier and UUID namespace supplied by the host application  |
| `HomeKitDevice.PLATFORM_NAME` | Platform identifier supplied by the host application                 |
| `HomeKitDevice.EVEHOME`    | Optional Eve-compatible history implementation                         |
| `HomeKitDevice.LOGGER`     | Shared logging implementation                                          |
| `HomeKitDevice.TYPE`       | Device family identifier                                               |
| `HomeKitDevice.VERSION`    | Base or subclass implementation version                               |
| `HomeKitDevice.HOMEBRIDGE` | Homebridge backend identifier                                          |
| `HomeKitDevice.HAP_NODEJS` | Standalone HAP-NodeJS backend identifier                               |
| `HomeKitDevice.HK_PIN_3_2_3` | RegExp for PIN format `xxx-xx-xxx`                            |
| `HomeKitDevice.HK_PIN_4_4`   | RegExp for PIN format `xxxx-xxxx`                             |
| `HomeKitDevice.MAC_ADDR`     | RegExp for HomeKit username format `XX:XX:XX:XX:XX:XX`        |

---

## Versioning

Each subclass may define a static `VERSION` string for visibility in logs:

```js
static VERSION = '2026.05.05';
```
