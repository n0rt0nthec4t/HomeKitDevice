# HomeKitDevice

Base class for all HomeKit accessories using HAP-NodeJS or Homebridge.  
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
- Safe characteristic binding (`addHKService`, `addHKCharacteristic`)
- EveHome-compatible history support (`history`)
- Internal device registry for UUID-based lookup and messaging

Supports both Homebridge plugins and standalone HAP-NodeJS environments.

---

## Subclassing Example

```js
import HomeKitDevice from './HomeKitDevice.js';

export default class MyDevice extends HomeKitDevice {
  static TYPE = 'MyDevice';
  static VERSION = '2025.06.18';

  async onAdd() {
    this.myService = this.addHKService(this.hap.Service.Switch);
    this.addHKCharacteristic(this.myService, this.hap.Characteristic.On, {
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

## Public Methods

### `addHKService(service)`

Adds the specified HAP service to the accessory if not already present.  
Returns the existing or newly created service instance.

---

### `addHKCharacteristic(service, characteristic, options)`

Binds a characteristic to the given service with handler and property options.

Supported `options`:

- `onSet(value)` – Called when HomeKit sets the characteristic value
- `onGet()` – Called when HomeKit reads the characteristic value
- `props` – Defines characteristic metadata (`minStep`, `unit`, `minValue`, `maxValue`, `validValues`, etc.)
- `initialValue` – Value to initialize immediately

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