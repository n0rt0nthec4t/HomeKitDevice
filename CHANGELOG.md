# Change Log

All notable changes to `HomeKitDevice` module will be documented in this file

## 2025/06/16

### Added
- Introduced standardized async lifecycle methods: `onAdd()`, `onUpdate()`, `onRemove()`, and `onMessage()`
- New `message(type, message)` dispatcher with internal handling of `UPDATE`, `REMOVE`
- Defined static constants: `HomeKitDevice.UPDATE`, `REMOVE`, `SET`, `GET`
- Introduced `makeValidHKName()` to sanitize HomeKit accessory names
- Added structured logging helper `postSetupDetail()` with support for log level and arguments

### Changed
- Renamed legacy `setupDevice()`, `updateDevice()`, etc., to `onX()` equivalents for consistency
- Normalized internal logging to use object-style `LOG_LEVELS` (`INFO`, `DEBUG`, `ERROR`, etc.)
- All subclass hooks now support `async/await`

### Fixed
- Improved UUID generation fallback when accessory not initialized
- Better clone logic for `deviceData` using `structuredClone()` to prevent reference sharing
