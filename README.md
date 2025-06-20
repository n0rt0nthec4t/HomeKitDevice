# HomeKitDevice

Base class for all HomeKit accessories using HAP-NodeJS or Homebridge.  
Provides internal device tracking, metadata validation, lifecycle management, message routing, and optional EveHome-compatible history logging.

---

## Overview

The `HomeKitDevice` module provides:

- Lifecycle hooks (`onAdd`, `onUpdate`, `onRemove`, `onMessage`, `onHistory`)
- Static and instance `.message()` routing
- Safe characteristic binding (`addHKService`, `addHKCharacteristic`)
- EveHome-compatible history support (`addHistory`, `setupEveHomeLink`)
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

    this.setupEveHomeLink(this.myService);
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

### `addHistory(target, entry, options?)`

Adds a structured entry to Eve-compatible history storage.

- Automatically sets `entry.time` to current epoch if missing
- Skips redundant entries unless `options.force === true`
- Uses `options.timegap` (in seconds) to suppress entries too close together
- Calls `.onHistory(type, entry)` if implemented by the subclass

```js
this.addHistory(this.myService, {
  status: 1,
  temperature: 22.5,
}, {
  timegap: 60,
  force: false,
});
```

---

### `setupEveHomeLink(service)`

Links a HomeKit service to the Eve app if `deviceData.eveHistory === true`.

```js
this.setupEveHomeLink(this.myService);
```

---

## Messaging

Send a message to any registered device using its UUID:

```js
HomeKitDevice.message(uuid, HomeKitDevice.SET, value);
```

This routes to the device’s `onMessage(type, message)` handler.

---

## Lifecycle Hooks

| Method                  | Called when...                                          |
|-------------------------|---------------------------------------------------------|
| `onAdd()`               | Accessory is being initialized                          |
| `onUpdate(deviceData)`  | Device configuration or metadata is updated             |
| `onRemove()`            | Device is removed or unpaired                           |
| `onMessage(type, msg)`  | Internal message received via `.message()`              |
| `onHistory(type, entry)`| After a history entry is successfully logged            |

---

## Static Constants

The following static constants are provided for internal message routing and validation:

| Constant         | Description                                                    |
|------------------|----------------------------------------------------------------|
| `SET`            | Used to deliver set-value messages to the device               |
| `GET`            | Used to request the current value/state from the device        |
| `UPDATE`         | Used to notify the device of updated configuration or state    |
| `REMOVE`         | Used to instruct the device to unregister or shut down         |
| `HK_PIN_3_2_3`   | RegExp for PIN format `xxx-xx-xxx`                             |
| `HK_PIN_4_4`     | RegExp for PIN format `xxxx-xxxx`                              |
| `MAC_ADDR`       | RegExp for HomeKit username format `XX:XX:XX:XX:XX:XX`         |

---

## Versioning

Each subclass may define a static `VERSION` string for visibility in logs:

```js
static VERSION = '2025.06.18';
```

---

## License

MIT License  
(c) Mark Hulskamp