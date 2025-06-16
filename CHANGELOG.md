# Change Log

All notable changes to the `HomeKitDevice` module are documented in this file.

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