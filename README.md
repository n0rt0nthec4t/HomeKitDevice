# HomeKitDevice

Base class for all HomeKit accessories using HAP-NodeJS or Homebridge.  
Provides internal device tracking, metadata validation, lifecycle management, HomeKit messaging, and optional EveHome-compatible history logging.

---

## Overview

This module provides:

- Device tracking and UUID generation
- HomeKit Accessory setup for Homebridge and HAP-NodeJS
- Lifecycle methods: `onAdd`, `onRemove`, `onUpdate`, `onMessage`, `onHistory`
- Static and instance `.message()` routing
- Characteristic handler registration (`SET`, `GET`, custom)
- Helper methods for setting up services and characteristics
- Optional `addHistory()` support for flat-file logging
- Optional EveHome linkage via `setupEveHomeLink()`

---

## Usage Example

```js
import HomeKitDevice from './HomeKitDevice.js';

export default class MyDevice extends HomeKitDevice {
  static PLUGIN_NAME = 'my-homebridge-plugin';
  static PLATFORM_NAME = 'MyPlatform';
  static TYPE = 'Sensor';
  static VERSION = '2025.06.18';

  async onAdd() {
    this.tempService = this.addHKService(this.hap.Service.TemperatureSensor);
    this.addHKCharacteristic(this.tempService, this.hap.Characteristic.CurrentTemperature, {
      onGet: () => this.deviceData?.temperature ?? 0,
    });

    if (this.deviceData?.eveHistory === true) {
      this.setupEveHomeLink(this.tempService);
    }
  }

  async onUpdate(deviceData) {
    this.tempService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.temperature);
    this.addHistory(this.tempService, { temperature: deviceData.temperature }, { timegap: 300 });
  }

  async onHistory(type, entry) {
    // Optional hook triggered after history is logged
    this.log.debug('History added:', type, entry);
  }
}
```

---

## Messaging System

The `HomeKitDevice.message()` static method supports routing messages to active instances:

| Type                          | Description                                  |
|-------------------------------|----------------------------------------------|
| `HomeKitDevice.UPDATE`        | Trigger device `.update()`                   |
| `HomeKitDevice.REMOVE`        | Trigger device `.remove()`                   |
| `HomeKitDevice.SET`           | Trigger `.deviceData` update with data merge |
| `HomeKitDevice.GET`           | Reserved for future                         |
| Custom strings                | Passed to `.onMessage(type, message)`        |

---

## History Logging

Devices can log flat-file history using:

```js
this.addHistory(service, { temperature: 25.3 }, { timegap: 300, force: true });
```

- `service`: a valid HomeKit characteristic or service object
- `entry`: object of key/value pairs (e.g., `{ status: 1, temperature: 23.1 }`)
- `options`: optional object with:
  - `timegap` (seconds): minimum spacing between entries of same type
  - `force` (true/false): bypass change detection and log anyway

If `entry.time` is missing, it will default to the current time.

To support EveHome linkage, subclass must call:

```js
this.setupEveHomeLink(service);
```

If `deviceData.eveHistory === true`, this will invoke `historyService.linkToEveHome(...)`.

---

## Requirements

Device `deviceData` must include:

- `serialNumber` (string)
- `softwareVersion` (string)
- `description` (string)
- `manufacturer` (string)
- `model` (string)

For **HAP-NodeJS** mode (standalone), also required:

- `hkUsername` (MAC-style)
- `hkPairingCode` (`XXX-XX-XXX` or `XXXX-XXXX`)

---

## License

Apache 2.0  
© Mark Hulskamp