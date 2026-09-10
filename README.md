# HomeKitDevice

Base class for accessories using standalone HAP-NodeJS or Homebridge with HAP and optional Matter.
Provides internal device tracking, metadata validation, lifecycle management, message routing, and optional EveHome-compatible history logging.

---

## Overview

All lifecycle transitions, internal events, and inter-device communication flow through the unified `message()` dispatch system.  
This ensures consistent execution ordering, prototype chain hook resolution, and centralized error handling across all device types.

The `HomeKitDevice` module provides:

- Lifecycle hooks (`onAdd`, `onUpdate`, `onRemove`, `onShutdown`, `onSet`, `onGet`, `onMessage`, `onHistory`, `onTimer`)
- Static and instance `.message()` routing
- Public wrapper methods (`add()`, `update()`, `remove()`, `shutdown()`, `get()`, `set()`, `history()`)
- Internal named timer system (`addTimer`, `removeTimer`, `hasTimer`)
- Safe service and characteristic helpers (`addService`, `removeService`, `addCharacteristic`, `removeCharacteristic`)
- EveHome-compatible history support (`history`)
- Internal device registry for UUID-based lookup and messaging

Supports Homebridge plugins using `api.hap`, optional Homebridge 2.x `api.matter`, and standalone HAP-NodeJS environments.

---

## Construction

Device subclasses use the base constructor signature:

```js
HomeKitDevice.LOGGER = log;
let device = new MyDevice(accessory, api, deviceData);
```

The optional `accessory` argument may be a Homebridge cached HAP accessory, a cached Matter accessory, or an array containing both. The `api` argument is the Homebridge platform API or a HAP-NodeJS API object. The `deviceData` object must contain the required fields listed below.

Under Homebridge, `this.hap` always references `api.hap`. When `api.isMatterEnabled()` returns `true` and `api.matter` is available, `this.matter` references `api.matter`; otherwise it is `undefined`. The presence of `api.matter` alone does not enable Matter for a bridge. Standalone HAP-NodeJS instances never expose Matter.

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
    this.deviceData = deviceData;
    this.log.debug('Updated deviceData', deviceData);
  }

  async onRemove() {
    this.log.info('Device removed');
  }

  async onMessage(type, message) {
    if (type === HomeKitDevice.SET) {
      this.setSwitch(message);
    }
  }

  onHistory(type, entry) {
    this.log.debug(`History logged for ${type}:`, entry);
  }

  setSwitch(value) {
    this.log.info('Switch set to:', value);
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

Matter uses the existing lifecycle and message routing API; it does not add protocol-specific lifecycle hooks. A subclass can assign a valid Homebridge `MatterAccessory` object to `this.matterAccessory` during `onAdd()`. After `onAdd()` completes, `add()` registers that object through `api.matter.registerPlatformAccessories()`.

Homebridge retains HAP as the default, including existing calls that omit all `add()` options. Set `hapAccessoryName` to `null` explicitly to request a Matter-only device:

```js
await device.add({ hapAccessoryName: null }); // Matter-only: onAdd() assigns this.matterAccessory
```

HAP `AccessoryInformation` and EveHome history setup run whenever `this.accessory` exists, covering both Homebridge HAP and standalone HAP-NodeJS. They are skipped only for Matter-only devices because a Matter accessory does not contain HAP services. During the normal `UPDATE` route, shared device information is synchronized to both representations: `description` becomes the Matter `displayName`, and manufacturer, model, serial number, and software version are mapped to their corresponding Matter metadata fields. Changed Matter metadata is persisted with one `this.matter.updatePlatformAccessories()` call.

Matter command handlers should route device writes through the existing `set()` or `message(HomeKitDevice.SET, ...)` flow. Operational device state continues through `update()` and `onUpdate()`, where a subclass can call `this.matter.updateAccessoryState()` directly. Standalone HAP-NodeJS continues to require the HAP name and category.

When `remove()` is called, whichever of `this.accessory` and `this.matterAccessory` exist are unregistered through their respective Homebridge APIs. Existing HAP-only subclasses require no changes.

For combined exposure, a Matter registration failure is logged and the registered HAP representation remains available. A Matter-only call returns `undefined` when no valid Matter representation can be registered; it does not report a successful setup.

The host Homebridge platform should pass objects restored by `configureAccessory()` and `configureMatterAccessory()` through the existing constructor `accessory` argument, either individually or in one combined array.

---

## Public Methods

### `add(options?)`

Creates and registers the representations requested by the device, then returns `true` when at least one valid representation is available. `options` is a plain object with these fields:

- `hapAccessoryName` – HAP accessory name. Set this to `null` for Matter-only operation.
- `hapCategory` – HAP accessory category, passed to Homebridge and required by standalone HAP-NodeJS.
- `enableHistory` – Whether to create EveHome history for a HAP representation. Defaults to `false`.

```js
await device.add({
  hapAccessoryName: 'Switch',
  hapCategory: this.hap.Categories.SWITCH,
  enableHistory: true,
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
- `initialValue` – Value to initialize immediately

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
- Calls `.onHistory(type, entry)` if implemented by the subclass

```js
this.history(this.myService, {
  status: 1,
  temperature: 22.5,
}, {
  timegap: 60,
  force: false,
});
```

### `shutdown()`

Triggers the `.SHUTDOWN` lifecycle message.  
Used during platform shutdown to allow devices to perform cleanup.

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
- Automatically updates HomeKit accessory information characteristics

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

This routes to the device’s `onMessage(type, message)` handler.

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

All timers are automatically cleaned up during `onShutdown()`.
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
  this.log.debug('Motion cooldown active');
}
```

---

## Lifecycle Hooks

| Method                      | Called when... |
|-----------------------------|----------------|
| `onAdd(message)`            | A `.ADD` message is received when the accessory is initialized |
| `onUpdate(deviceData)`      | A `.UPDATE` message updates the device configuration/state |
| `onRemove(message)`         | A `.REMOVE` message unregisters the device permanently |
| `onShutdown(message)`       | A `.SHUTDOWN` message is received during platform shutdown |
| `onSet(message)`            | A `.SET` message applies new values |
| `onGet(message)`            | A `.GET` message queries current values/state |
| `onTimer(message)`          | A `.TIMER` message is dispatched by internal timers |
| `onHistory(type, entry)`    | After a history entry is successfully logged |
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

These constants are used internally for structured messaging and lifecycle dispatch:

| Constant                  | Description                                                      |
|---------------------------|------------------------------------------------------------------|
| `HomeKitDevice.ADD`       | Sent during accessory initialization (`onAdd`)                   |
| `HomeKitDevice.UPDATE`    | Sent to apply updated device data (`onUpdate`)                   |
| `HomeKitDevice.REMOVE`    | Sent to unregister the accessory (`onRemove`)                    |
| `HomeKitDevice.SET`       | Sent to apply new values (`onSet`)                               |
| `HomeKitDevice.GET`       | Sent to query device state (`onGet`)                             |
| `HomeKitDevice.HISTORY`   | Sent when a history entry is logged (`onHistory`)                |
| `HomeKitDevice.SHUTDOWN`  | Sent during controlled shutdown (`onShutdown`)                   |
| `HomeKitDevice.TIMER`     | Sent when an internal timer fires (`onTimer`)                    |
| `HomeKitDevice.ONLINE`    | Sent when device transitions to online state                     |
| `HomeKitDevice.OFFLINE`   | Sent when device transitions to offline state                    |
| `HomeKitDevice.HK_PIN_3_2_3` | RegExp for PIN format `xxx-xx-xxx`                            |
| `HomeKitDevice.HK_PIN_4_4`   | RegExp for PIN format `xxxx-xxxx`                             |
| `HomeKitDevice.MAC_ADDR`     | RegExp for HomeKit username format `XX:XX:XX:XX:XX:XX`        |

---

## Versioning

Each subclass may define a static `VERSION` string for visibility in logs:

```js
static VERSION = '2026.05.05';
```
