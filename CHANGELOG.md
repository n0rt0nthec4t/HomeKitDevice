# Change Log

All notable changes to the `HomeKitDevice` module are documented in this file.

## 2026/09/11

### Changed

- Honoured Homebridge's optional `api.isHapEnabled()` result before exposing HAP, restoring cached HAP accessories, or creating new HAP platform accessories, while retaining HAP-by-default compatibility with older Homebridge versions
- Separated standalone HAP-NodeJS and Homebridge platform accessory creation into explicit backend paths
- Restored the Homebridge HAP registration boundary so cached accessories are reconfigured without being registered or rolled back as new accessories
- Added `matterDeviceType` so the base class creates the minimum Matter descriptor before `onAdd()`, allowing subclasses to complete it before registration
- Prevented `onAdd()` from running when HAP and Matter setup leave no usable accessory representation
- Restored setup logging to use `hapAccessoryName` when supplied and the device description when it is omitted

## 2026/09/09

### Changed

- Required Homebridge's `api.isMatterEnabled()` to return true before exposing Matter or restoring cached Matter accessories
- Replaced positional `add()` arguments with an options object containing `hapAccessoryName`, `hapCategory`, and `enableHistory`
- Passed `hapCategory` to newly created Homebridge platform accessories

## 2026/09/08

### Added

- Added initial Homebridge 2.x Matter boundary through `this.matter` and `this.matterAccessory`
- Added restoration of cached HAP and Matter representations through the existing constructor accessory argument
- Added Matter registration and unregistration to the existing `ADD` and `REMOVE` lifecycle flow
- Added tests covering combined Homebridge HAP/Matter operation and standalone HAP-NodeJS operation

### Changed

- Clarified that `backend` identifies the runtime: standalone HAP-NodeJS or Homebridge, with Homebridge optionally providing both HAP and Matter
- Restructured `add()` into standalone HAP-NodeJS, Homebridge HAP, shared HAP metadata/history, and Homebridge Matter phases
- Allowed Homebridge Matter-only devices to omit the HAP name/category without creating a HAP accessory or requiring `AccessoryInformation`
- Synchronized shared name, manufacturer, model, serial number, and firmware metadata to Matter during the existing `UPDATE` route
- Coalesced changed Matter metadata into one `updatePlatformAccessories()` call and retained retryable local values when that call fails
- Preserved HAP as the default for existing Homebridge `add()` calls and made `add(null)` the explicit Matter-only form
- Validated HAP information before registration, reported failed setup truthfully, and retained HAP when optional Matter registration fails
- Included HAP information and display-name changes in Homebridge cache update detection
- Registered shutdown handling once per runtime API source rather than only for the first backend encountered
- Made accessory UUID generation deterministic across the Homebridge HAP/Matter aliases and direct HAP-NodeJS, failing closed when generation is invalid
- Kept Matter registration state local to `add()` and cleared descriptors that fail registration
- Derived HAP and Matter readiness from their representation objects instead of parallel setup flags
- Simplified setup logging so the backend and registered HAP/Matter representations are each reported once
- Kept the existing lifecycle hooks, message types, and helper method names unchanged

## 2026/08/18

### Changed

- Updated `makeValidHKName()` to return `Unknown Device` when sanitisation leaves no valid HomeKit name

### Fixed

- Awaited standalone HAP-NodeJS accessory publication and unpublication so lifecycle completion and failures are handled deterministically
- Prevented a cancelled or replaced delayed repeating timer from creating an orphaned interval after its first callback
- Prevented history hooks from firing when a duplicate or invalid history entry was not submitted to storage

## 2026/05/09

### Changed
- Renamed HomeKit helper methods to `addService()`, `removeService()`, and `addCharacteristic()`
- Added `removeService()` helper for removing HomeKit services by instance or service type
- Added `removeCharacteristic()` helper for removing HomeKit characteristics by instance or characteristic type
- Added static `HomeKitDevice.LOGGER` support so subclasses can use a shared logger without receiving it through the constructor
- Changed unhandled internal message logging from warning to debug to reduce noise for optional message notifications
- Awaited online/offline message dispatch during device update processing so handlers complete in a deterministic order

## 2026/05/05

### Changed
- Refined shutdown handling:
  - Added internal guard flags to prevent duplicate shutdown execution
  - Ensures consistent cleanup across Homebridge and HAP-NodeJS backends
  - Retains existing `shutdown()` API without introducing additional helper methods

- Improved timer execution safety:
  - Prevent overlapping timer execution using internal `running` guard
  - Ensures one-shot timers are only removed after callback/message completion
  - Prevents race conditions between `removeTimer()` and in-flight executions

- Enhanced history change detection:
  - Introduced normalisation of object values before comparison
  - Prevents false-positive history entries due to key ordering differences

- Scoped message payload normalisation:
  - Only lifecycle messages (`ADD`, `UPDATE`, `REMOVE`, `SET`) auto-normalise to `{}` when undefined/null
  - Prevents unintended mutation of custom or non-lifecycle message payloads

### Fixed
- Fixed potential timer race condition where removal could occur before async execution completed
- Fixed history comparison inconsistencies with nested object values
- Fixed minor internal message handling edge cases during lifecycle dispatch

### Cleaned
- Removed dead/unused inline variables and minor structural inconsistencies
- Standardised inline validation patterns across timer configuration
- Minor internal refactoring for consistency with project coding style

## 2026/04/28

### Changed
- Centralised shutdown handling across **Homebridge** and **HAP-NodeJS** backends.
- Added guarded, idempotent shutdown logic to ensure device cleanup is only executed once.
- Replaced separate signal/platform handlers with a unified internal shutdown dispatcher.
- Improved reliability of device teardown (timers, listeners) during process exit.

## 2026/03/20

### Changed
- Improved handling of EveHome linking during device initialisation.
- Services are linked when `eveHistory === true` and fully unlinked when disabled.
- EveHome history service and associated Eve-specific characteristics are now removed automatically when `eveHistory` is disabled.

## 2026/03/04

### Added
- Added automatic shutdown detection within `HomeKitDevice`.
- When running under **Homebridge**, the module now listens for the platform `shutdown` event.
- When running under **HAP-NodeJS**, the module now listens for `SIGTERM` and `SIGINT` process signals.
- Registered devices are notified of shutdown via the `.SHUTDOWN` lifecycle message, allowing them to perform cleanup before the process exits.

### Changed
- Shutdown propagation is now handled internally by `HomeKitDevice`.

## 2026/03/03

### Added
- Added `HomeKitDevice.SHUTDOWN` lifecycle message type.
- Introduced `shutdown()` wrapper method to trigger controlled runtime teardown.
- Added `onShutdown(message)` lifecycle hook for subclass-specific shutdown logic.
- Implemented internal device-scoped timer system with three firing patterns: delay-only, interval-only, and delay+interval
  - Timer callbacks support direct callback execution or message-driven dispatch via `options.message` payload
  - Non-blocking execution model prevents interval stalling if timer handlers take time
  - `addTimer(timerHandle, options, callback)`
  - `removeTimer(timerHandle)`
  - `hasTimer(timerHandle)`
- Added `HomeKitDevice.TIMER` message type.
- Added `onTimer(message)` lifecycle hook for message-driven timer handling.
- Automatic cleanup of all registered timers during `.SHUTDOWN` and `.REMOVE`.

### Changed
- Refined lifecycle model to clearly distinguish between `.REMOVE` (permanent deregistration) and `.SHUTDOWN` (runtime teardown only).
- Integrated timer execution with the unified `.message()` dispatch system when no callback is supplied.
- Updated README documentation to reflect the enhanced lifecycle and scheduling architecture.

## 2025/11/24
- Improved error handling under HomeBridge 2.0 when registering an existing accessory. This appears due to change in HAP-NodeJS 1x vs 2.x library

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
- `addService()` accepts `eveOptions` object to defer Eve linkage until `.add()` completes.

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
- Introduced standardised async lifecycle hooks: `onAdd()`, `onUpdate(deviceData)`, `onRemove()`, `onMessage(type, message)`
- Exposed `message(type, message)` dispatcher with internal handling for `UPDATE` and `REMOVE`
- Added static constants: `HomeKitDevice.UPDATE`, `REMOVE`, `SET`, `GET`
- Added utility method `makeValidHKName()` for sanitising HomeKit display names
- Added `postSetupDetail()` for structured logging with optional log level and arguments
- Added helper methods: `addService()` and `addCharacteristic()` for simplified service/characteristic setup

### Changed
- Made `uuid` and `platform` private fields (`#uuid`, `#platform`) for encapsulation
- Refined backend detection and assignment to `backend` variable
- Replaced legacy methods (`setupDevice()`, `updateDevice()`, etc.) with unified `onX()` lifecycle hooks
- Standardised logging via `LOG_LEVELS` constants (`INFO`, `DEBUG`, `ERROR`, etc.)
- Lifecycle methods are now fully `async`-aware for subclass overrides
- Clarified runtime environment detection for Homebridge vs HAP-NodeJS

### Fixed
- Improved fallback logic for UUID generation using `crypto.randomUUID()` if HAP not available
- Fixed cloning of `deviceData` using `structuredClone()` to avoid shared object references
