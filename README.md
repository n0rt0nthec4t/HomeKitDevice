# HomeKitDevice

Base class for all HomeKit accessories using HAP-NodeJS or Homebridge.  
Provides internal device tracking, metadata validation, lifecycle management, and message routing.  
Supports optional EveHome history integration.

---

## Overview

This module provides:

- Lifecycle methods: `onAdd`, `onRemove`, `onUpdate`, `onMessage`
- Static and instance `.message()` routing
- Device registry (by UUID)
- SET/GET characteristic handler support
- Device metadata validation

---

## Example: Subclassing

```js
import HomeKitDevice from './HomeKitDevice.js';

export default class MyDevice extends HomeKitDevice {
  onAdd() {
    this.log.info('Device added');
  }

  onRemove() {
    this.log.info('Device removed');
  }

  onUpdate(deviceData) {
    this.deviceData = deviceData;
  }

  onMessage(type, message) {
    if (type === 'SET') {
      this.targetState = message;
    }
  }
}
```

---

## Required `deviceData`

Each device must be initialized with the following structure:

```js
const deviceData = {
  serialNumber: 'ABC123456',
  softwareVersion: '1.0.0',
  description: 'ABC Device',
  manufacturer: 'Device',
  model: '123456',

  // Required when using HAP-NodeJS (standalone mode)
  hkUsername: '11:22:33:44:55:66',
  hkPairingCode: '123-45-678'
};
```

---

## Static Constants to Define

Define the following constants in your module or subclass:

```js
HomeKitDevice.PLUGIN_NAME = 'homebridge-xxxxx';
HomeKitDevice.PLATFORM_NAME = 'SomePlatform';
HomeKitDevice.TYPE = 'ADevice';
HomeKitDevice.VERSION = 'x.x.x';

// Optional [EveHome-compatible history integration](https://github.com/n0rt0nthec4t/HomeKitHistory)
HomeKitDevice.HOMEKITHISTORY = HomeKitHistory;
```

---

## Lifecycle Methods

These methods are called automatically by the framework:

| Method                  | Description                                        |
|-------------------------|----------------------------------------------------|
| `onAdd()`               | Called when the device is first added              |
| `onRemove()`            | Called when the device is removed                  |
| `onUpdate(deviceData)`  | Called with new `deviceData` on config update      |
| `onMessage(type, msg)`  | Called for messages like `'SET'`, `'GET'`, etc.    |

---

## Message Types

These are the only types handled by the base class:

| Type       | Routed To               | Description                                      |
|------------|-------------------------|--------------------------------------------------|
| `'SET'`    | Registered handler or `onMessage` | Set a value (e.g. from HomeKit)        |
| `'GET'`    | Registered handler or `onMessage` | Get a value (return value or Promise)  |
| `'UPDATE'` | `onUpdate(deviceData)`  | Update the device data                          |
| `'REMOVE'` | `onRemove()`            | Remove the device                               |

---

## Static Messaging API

Send or register messages by UUID.

### Send a message to a device

```js
await HomeKitDevice.message(uuid, 'SET', true);
const value = await HomeKitDevice.message(uuid, 'GET');
await HomeKitDevice.message(uuid, 'UPDATE', updatedDeviceData);
await HomeKitDevice.message(uuid, 'REMOVE');
```

### Register handlers for SET / GET

```js
HomeKitDevice.message(uuid, 'SET', (value) => {
  this.state = value;
});

HomeKitDevice.message(uuid, 'GET', () => {
  return this.state;
});
```

---

## Instance Messaging API

Use `.message()` from within a device instance:

```js
await this.message('SET', false);
const state = await this.message('GET');
```

---

## Example: Handling onMessage

```js
onMessage(type, message) {
  if (type === 'SET') {
    this.mode = message;
  } else if (type === 'GET') {
    return this.mode;
  }
}
```

---

## Notes

- `.set()` and `.get()` are deprecated — use `.message('SET')` / `'GET'`
- Devices are auto-registered and routable via UUID
- Only `'SET'`, `'GET'`, `'UPDATE'`, and `'REMOVE'` are reserved message typesare reserved message types