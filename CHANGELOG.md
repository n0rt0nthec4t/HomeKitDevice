# Change Log

All notable changes to the `HomeKitDevice` module are documented in this file.

## 2025/06/18

### Added
- `addHistory()` method to `HomeKitDevice`:
  - Supports safe history logging with change detection and optional force
  - Accepts either service or characteristic as target
  - Automatically adds `entry.time` if missing
- `onHistory(type, entry)` lifecycle hook:
  - Invoked after each successful history entry
  - Allows subclasses to respond to logged events
- `setupEveHomeLink(service, options)` method:
  - Conditionally links a service to EveHome if `deviceData.eveHistory` is enabled
  - Validates service ownership before linking
  - Can be called from `.onAdd()` for dynamic EveHome compatibility

## 2025/06/17

### Added
- `HomeKitDevice` now extends `EventEmitter`, allowing each device to emit and listen to events independently
- Internal device registry (`#deviceRegistry`) tracks all registered device instances by UUID
- Internal listener registry (`#listeners`) supports static registration of per-device message handlers
- Static `HomeKitDevice.message(uuid, type, message)` method sends messages to active device instances
- Instance `.message(type, message)` handles `UPDATE` and `REMOVE` messages directly, and delegates custom handling to `onMessage(type, message)`
- Lifecycle event listeners now automatically registered via `this.on(this.#uuid, this.message.bind(this))`

### Changed
- Removed `.set()` and `.get()` methods in favor of unified `.message()` dispatching for communication
- `remove()` now cleans up internal event listeners and deregisters device from the registry
- `uuid` and `platform` are now private fields (`#uuid`, `#platform`) for encapsulation

### Notes
- Devices no longer require a shared event emitter for messaging; all routing is internal
- Existing subclass methods `onAdd()`, `onUpdate(deviceData)`, `onRemove()`, and `onMessage(type, message)` remain supported

## 2025/06/16

### Added
- Defined static backend constants: `HomeKitDevice.HOMEBRIDGE` and `HomeKitDevice.HAPNODEJS`
- Added `backend` instance variable to reflect runtime context (`homebridge` or `hap-nodejs`)
- Introduced standardized async lifecycle hooks: `onAdd()`, `onUpdate(deviceData)`, `onRemove()`, `onMessage(type, message)`
- Exposed `message(type, message)` dispatcher with internal handling for `UPDATE` and `REMOVE`
- Added static constants: `HomeKitDevice.UPDATE`, `REMOVE`, `SET`, `GET`
- Added utility method `makeValidHKName()` for sanitizing HomeKit display names
- Added `postSetupDetail()` for structured logging with optional log level and arguments
- Added helper methods: `addHKService()` and `addHKCharacteristic()` for simplified service/characteristic setup

### Changed
- Made `uuid` and `platform` private fields (`#uuid`, `#platform`) for encapsulation
- Refined backend detection and assignment to `backend` variable
- Replaced legacy methods (`setupDevice()`, `updateDevice()`, etc.) with unified `onX()` lifecycle hooks
- Standardized logging via `LOG_LEVELS` constants (`INFO`, `DEBUG`, `ERROR`, etc.)
- Lifecycle methods are now fully `async`-aware for subclass overrides
- Clarified runtime environment detection for Homebridge vs HAP-NodeJS

### Fixed
- Improved fallback logic for UUID generation using `crypto.randomUUID()` if HAP not available
- Fixed cloning of `deviceData` using `structuredClone()` to avoid shared object references