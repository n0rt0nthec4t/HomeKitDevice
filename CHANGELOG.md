# Change Log

All notable changes to the `HomeKitDevice` module are documented in this file.

## 2025/07/29

### Changed
- `HomeKitDevice.EVEHOME` replaces `HomeKitDevice.HISTORY` as the standard reference for Eve-compatible history modules.

## 2025/07/07

### Changed
- Improved `HomeKitDevice.message()` to avoid duplicate handler registration by checking for existing `{ handler, context }` using `=== undefined` for explicit comparison.
- Simplified registration checks by using inline conditional logic for detecting plain objects and function-based handlers.
- Refactored `callLifecycleHook()` to:
  - Traverse prototype chain from instance to base class for method resolution.
  - Use a `Set` to track and prevent duplicate function/context calls.
  - Improve error logging with clearer context labels.
- Unified lifecycle hook dispatch for string-based, function, and array-of-handlers invocation models.
- Applied optional chaining consistently throughout message routing and lifecycle handling logic.

## 2025/06/28

### Added
- EveHome command handling is now routed via `.message()` using `HomeKitDevice.HISTORY.GET` and `.SET` message types.
- Devices can now respond to Eve-specific requests by implementing `onMessage(type, message)` instead of defining `getcommand`/`setcommand` callbacks.
- `addHKService()` accepts `eveOptions` object to defer Eve linkage until `.add()` completes.

### Changed
- `HomeKitDevice.HISTORY` replaces `HOMEKITHISTORY` as the standard reference for Eve-compatible history modules.


## 2025/06/27

### Added
- Added `get()`, `set()`, and `history()` wrapper methods to simplify triggering standard lifecycle message flows.
- Added automatic deduplication and time patching logic for `.HISTORY` messages.

### Changed
- Refactored `.message()` to consolidate dynamic and static handler calls using a unified `callHandler()` helper.
- Optional chaining (`fn?.(...args)`) now used in `callHandler()` to simplify function existence checks.
- `methodName` is now extracted via regex only if `type` is a string; added fallback logging for invalid or unknown message types.
- Dynamic methods (e.g., `onAdd`, `onSet`) and static handlers now both update `handled` consistently after invocation.
- Internal `deviceData` is now updated after `.SET` message handlers complete, preserving legacy behavior.

### Fixed
- Fixed a regression where `type.match(...)` could throw when `type` was not a string.
- Fixed `get()` not returning values from `onGet` or static handlers due to missing `return`.

## 2025/06/26

### Added
- Added `onSet(message)` and `onGet(message)` lifecycle hooks for direct handling of `.SET` and `.GET` messages.
- Instance `.message()` now supports `.SET` and `.GET` with dedicated handling and fallback to `onMessage()`.
- Updated README with full lifecycle hook and static constant reference tables.

### Changed
- Consolidated internal `.message()` dispatch logic to reduce duplication and ensure consistent fallback behavior.

### Fixed
- `.GET` messages now return results from `onGet()` or registered handler properly.

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