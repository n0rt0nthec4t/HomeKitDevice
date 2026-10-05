// Base Class: HomeKitDevice
//
// Shared base class for HAP and Matter devices across multiple projects.
// Supports the Homebridge runtime (optional HAP and Matter) and the direct
// HAP-NodeJS runtime.
//
// Provides a unified abstraction layer that standardises accessory creation,
// lifecycle handling, message routing, timer management, and optional
// EveHome history support across all device types.
//
// Responsibilities:
// - Manage HAP and Matter representation creation and removal
// - Provide unified message routing for device lifecycle and custom events
// - Maintain internal device registry -> cross device messaging
// - Standardise HAP service/characteristic and Matter cluster helper methods
// - Integrate optional EveHome compatible history support
// - Provide internal timer management for device instances
//
// Lifecycle Hooks (optional in subclasses):
// - onAdd(message, ...args)       -> called when HomeKitDevice.ADD is received
// - onSet(message, ...args)       -> called when HomeKitDevice.SET is received
// - onUpdate(deviceData, ...args) -> called when HomeKitDevice.UPDATE is received
// - onRemove(message, ...args)    -> called when HomeKitDevice.REMOVE is received
// - onShutdown(message, ...args)  -> called when HomeKitDevice.SHUTDOWN is received
// - onTimer(message, ...args)     -> called when HomeKitDevice.TIMER is received
// - onGet(message, ...args)       -> called when HomeKitDevice.GET is received
// - onHistory(target, entry, options)
//                                  -> called after history processing
// - onMessage(type, message, ...args)
//                                  -> fallback for unhandled or custom message types
//
// Messaging Model:
// - device.message(type, message, ...args)
//     -> routes a message to this device instance
// - HomeKitDevice.message(uuid, type, message, ...args)
//     -> routes a message to another registered device instance
// - Internal lifecycle events and custom interactions use the same message system
//
// Key Features:
// - addService() / addCharacteristic() / addMatterCluster()
//     -> simplified HAP and Matter setup helpers
// - addTimer() / removeTimer() / hasTimer()
//     -> per-device timer management
// - history()
//     -> EveHome-compatible history logging and hook dispatch
// - Static device registry
//     -> enables global device message routing
//
// Architecture:
// - Designed to be extended per device type (e.g. Camera, Thermostat, Valve)
// - Operates as the abstraction layer between raw device data and HAP/Matter representations
// - Can run under Homebridge or standalone HAP-NodeJS environments
//
// Example:
//
// class MyDevice extends HomeKitDevice {
//   async onAdd() {
//     if (this.accessory !== undefined) {
//       this.addService(this.hap.Service.Switch, this.deviceData.description);
//     }
//
//     if (this.matterAccessory !== undefined) {
//       this.addMatterCluster(this.matter.clusterNames.OnOff, {
//         initialState: { onOff: this.deviceData.on === true },
//         handlers: {
//           on: () => this.set({ on: true }),
//           off: () => this.set({ on: false }),
//         },
//       });
//     }
//   }
//
//   async onUpdate(deviceData) {
//     if (this.matterAccessory !== undefined) {
//       await this.matter.updateAccessoryState(
//         this.uuid,
//         this.matter.clusterNames.OnOff,
//         { onOff: deviceData.on === true },
//       );
//     }
//   }
// }
//
// HomeKitDevice.LOGGER = log;
// let device = new MyDevice(cachedAccessory, api, deviceData);
// await device.add({
//   hapAccessoryName: 'My Device',
//   hapCategory: api.hap.Categories.SWITCH,
//   matterDeviceType: api.matter?.deviceTypes.OnOffSwitch,
// });
//
// Notes:
// - Designed for subclassing only
// - Supports optional HAP and Matter representations under Homebridge, and HAP under HAP-NodeJS
// - Homebridge platform shutdown and process exit cleanup are handled centrally
// - Bridged HAP cache changes and Matter metadata/context changes are persisted through their respective APIs
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import process from 'node:process';

// Define constants
const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

/**
 * Core identity and metadata shared by HAP and Matter representations.
 * Device subclasses may add their own fields to this object.
 *
 * @typedef {object} HomeKitDeviceData
 * @property {string} serialNumber Stable device serial number.
 * @property {string} softwareVersion Device firmware or software version.
 * @property {string} description User-visible device name.
 * @property {string} manufacturer Device manufacturer.
 * @property {string} model Device model.
 * @property {string} [hkUsername] MAC-style HAP username required by standalone HAP-NodeJS.
 * @property {string} [hkPairingCode] HAP setup code required by standalone HAP-NodeJS.
 * @property {boolean} [online] Current device reachability state.
 * @property {boolean} [eveHistory] Whether configured HAP services should be linked to Eve history.
 */

/**
 * Options controlling which protocol representations are created by {@link HomeKitDevice#add}.
 *
 * @typedef {object} HomeKitDeviceAddOptions
 * @property {string|null} [hapAccessoryName] HAP name, or `null` to suppress creation of a new HAP accessory.
 * @property {number} [hapCategory] HAP accessory category; required by standalone HAP-NodeJS.
 * @property {boolean} [externalPublish=false] Whether Homebridge should publish the HAP accessory outside its bridge.
 * @property {object} [matterDeviceType] Homebridge Matter device type descriptor.
 * @property {boolean} [enableHistory=false] Whether to create Eve-compatible history for the HAP representation.
 */

/**
 * Options for an Eve-compatible history entry.
 *
 * @typedef {object} HomeKitHistoryOptions
 * @property {boolean} [force=false] Store the entry even when its values match the latest entry.
 * @property {number} [timegap] Minimum interval in seconds delegated to the history service.
 */

/**
 * Options for a named device timer.
 *
 * @typedef {object} HomeKitTimerOptions
 * @property {number} [delay] Milliseconds before the first invocation.
 * @property {number} [interval] Milliseconds between repeated invocations.
 * @property {boolean} [reset=false] Replace an existing timer with the same handle.
 * @property {Object<string, *>} [message] Payload supplied to the callback or `onTimer` hook.
 */

/**
 * Called when a named device timer fires.
 *
 * @callback HomeKitTimerCallback
 * @param {string} timerHandle Name of the timer that fired.
 * @param {Object<string, *>} message Timer payload.
 * @returns {*|Promise<*>} Optional callback result; timer execution does not consume it.
 */

/**
 * Options applied while resolving a HAP characteristic.
 *
 * @typedef {object} HomeKitCharacteristicOptions
 * @property {Object<string, *>} [props] HAP characteristic constraints and metadata.
 * @property {Function} [onSet] Handler invoked for a HomeKit write.
 * @property {Function} [onGet] Handler invoked for a HomeKit read.
 * @property {*} [initialValue] Value applied through the service without invoking `onSet`.
 */

/**
 * Declarative state and command handlers for a Matter cluster.
 *
 * @typedef {object} HomeKitMatterClusterOptions
 * @property {Object<string, *>} [initialState] Initial cluster attribute values.
 * @property {Object<string, Function>} [handlers] Command names mapped to their handlers.
 */

/**
 * Base abstraction for devices exposed through HAP and/or Matter.
 *
 * HomeKitDevice owns device identity, persistence, protocol representation
 * lifecycle, message routing, history integration, and timer management.
 * Device-specific implementations extend this class and implement the
 * appropriate lifecycle hooks.
 *
 * @extends EventEmitter
 */
export default class HomeKitDevice extends EventEmitter {
  // Device messages
  static ADD = 'HomeKitDevice.onAdd';
  static UPDATE = 'HomeKitDevice.onUpdate';
  static REMOVE = 'HomeKitDevice.onRemove';
  static HISTORY = 'HomeKitDevice.onHistory';
  static SET = 'HomeKitDevice.onSet';
  static GET = 'HomeKitDevice.onGet';
  static MESSAGE = 'HomeKitDevice.onMessage';
  static SHUTDOWN = 'HomeKitDevice.onShutdown';
  static TIMER = 'HomeKitDevice.onTimer';
  static ONLINE = 'HomeKitDevice._online';
  static OFFLINE = 'HomeKitDevice._offline';

  // HomeKit pin format and MAC address regex patterns
  static HK_PIN_3_2_3 = /^\d{3}-\d{2}-\d{3}$/;
  static HK_PIN_4_4 = /^\d{4}-\d{4}$/;
  static MAC_ADDR = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

  // Override this in the class which extends
  static PLUGIN_NAME = undefined; // Homebridge plugin name
  static PLATFORM_NAME = undefined; // Homebridge platform name
  static EVEHOME = undefined; // HomeKitHistory object
  static LOGGER = undefined; // Logging object
  static TYPE = 'base'; // String naming type of device
  static VERSION = '2026.10.05'; // Code version

  // Persistent context namespace for this class. Subclasses may override to isolate their own context.
  static PERSISTENCE_NAMESPACE = 'HomeKitDevice';

  // Backend types
  static HOMEBRIDGE = 'homebridge';
  static HAP_NODEJS = 'hap-nodejs';

  // Global internal device and listener registry
  static #listeners = {};
  static #deviceRegistry = new Map();
  static #shutdownRegistered = new WeakSet();
  static #shutdownFired = false;

  deviceData = {}; // The devices data we store
  historyService = undefined; // HomeKit history service
  accessory = undefined; // Standalone or Homebridge HAP accessory for this device
  matterAccessory = undefined; // Homebridge Matter accessory for this device
  hap = undefined; // HomeKit Accessory Protocol (HAP) API stub
  matter = undefined; // Homebridge Matter API stub when enabled for this bridge
  log = undefined; // Logging function object
  backend = undefined; // Runtime backend type

  // Internal data only for this class
  #uuid = undefined; // UUID for this instance
  #platform = undefined; // Homebridge platform API
  #persistedFields = []; // deviceData fields restored from accessory context
  #postSetupDetails = []; // Use for extra output details once a device has been setup
  #timers = new Map(); // Internal timers for this device

  /**
   * Create a HomeKit device instance.
   *
   * @param {object|object[]|undefined} accessory Restored Homebridge accessory representation or representations.
   * @param {object|undefined} api Homebridge API or HAP-NodeJS API.
   * @param {HomeKitDeviceData} deviceData Initial device data.
   * @param {string[]} persistedFields Device data fields persisted in accessory context.
   * @throws {TypeError} When device data or persisted fields fail validation.
   */
  constructor(accessory = undefined, api = undefined, deviceData = {}, persistedFields = []) {
    super(); // Setup event emitter for our class ONLY

    // Build logger from configured backend using only functions that exist.
    let logger = {};
    Object.values(LOG_LEVELS).forEach((level) => {
      if (typeof HomeKitDevice.LOGGER?.[level] === 'function') {
        logger[level] = HomeKitDevice.LOGGER[level].bind(HomeKitDevice.LOGGER);
      }
    });
    if (Object.keys(logger).length !== 0) {
      this.log = logger;
    }

    // Determine runtime environment (Homebridge vs HAP-NodeJS)
    if (typeof api?.hap === 'object' && isNaN(api?.version) === false && typeof api?.HAPLibraryVersion === 'undefined') {
      // HAP is enabled by default on Homebridge versions without the explicit
      // enablement API. Once available, a false result suppresses this bridge's
      // HAP representation in the same way Matter is suppressed below.
      this.hap = api?.isHapEnabled?.() !== false ? api.hap : undefined;
      this.matter =
        api?.isMatterEnabled?.() === true && typeof api?.matter === 'object' && api.matter !== null
          ? api.matter
          : undefined;
      this.#platform = api;
      this.backend = HomeKitDevice.HOMEBRIDGE;
      this.postSetupDetail('Homebridge backend', LOG_LEVELS.DEBUG);
    }

    if (typeof api?.hap === 'undefined' && isNaN(api?.version) === true && typeof api?.HAPLibraryVersion === 'function') {
      this.hap = api;
      this.backend = HomeKitDevice.HAP_NODEJS;
      this.postSetupDetail('HAP-NodeJS library', LOG_LEVELS.DEBUG);
    }

    // Register shutdown once per runtime emitter. The WeakSet avoids retaining
    // discarded Homebridge APIs, while the callback prevents overlapping events.
    const shutdown = async () => {
      if (HomeKitDevice.#shutdownFired === false) {
        HomeKitDevice.#shutdownFired = true;
        await HomeKitDevice.shutdown();
      }
    };

    if (
      this.backend === HomeKitDevice.HOMEBRIDGE &&
      typeof this.#platform?.on === 'function' &&
      HomeKitDevice.#shutdownRegistered.has(this.#platform) === false
    ) {
      HomeKitDevice.#shutdownRegistered.add(this.#platform);
      this.#platform.on('shutdown', shutdown);
    }

    if (
      this.backend === HomeKitDevice.HAP_NODEJS &&
      HomeKitDevice.#shutdownRegistered.has(process) === false
    ) {
      HomeKitDevice.#shutdownRegistered.add(process);
      ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, shutdown));
    }

    // Validate the data passed in to the constructor to ensure we have the minimum required data to create a HomeKit accessory
    if (this.#validDeviceData(deviceData, true) === false) {
      throw new TypeError('Invalid device data supplied to HomeKitDevice');
    }
    if (
      Array.isArray(persistedFields) === false ||
      persistedFields.some((field) => typeof field !== 'string' || field === '') ||
      new Set(persistedFields).size !== persistedFields.length
    ) {
      throw new TypeError('Invalid persisted device data fields supplied to HomeKitDevice');
    }

    // Store independent copies of the initial device data and persisted field list
    // so later caller mutations cannot change this instance's data or persistence rules.
    this.deviceData = structuredClone(deviceData);
    this.#persistedFields = [...persistedFields];

    // This UUID is the persistent internal identity shared by the device's HAP
    // and Matter representations, so generation must succeed before registration.
    this.#uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, this.deviceData.serialNumber);

    // Register this device instance in the static device registry
    HomeKitDevice.#deviceRegistry.set(this.#uuid, this);

    // See if we were passed an existing accessory object or array of accessory objects.
    // Homebridge restores HAP and Matter accessories through separate callbacks, but
    // callers can combine those cached objects in the existing constructor argument.
    if (typeof accessory === 'object' && accessory !== null && this.backend === HomeKitDevice.HOMEBRIDGE) {
      // HAP and Matter cache objects have no shared base type, so identify them
      // by the capabilities Homebridge exposes on each representation.
      (Array.isArray(accessory) === true ? accessory : [accessory]).forEach((cachedAccessory) => {
        if (cachedAccessory?.UUID === this.#uuid) {
          if (this.hap !== undefined && typeof cachedAccessory?.getService === 'function') {
            this.accessory ??= cachedAccessory;
          } else if (
            this.matter !== undefined &&
            typeof cachedAccessory?.getService !== 'function' &&
            cachedAccessory?.deviceType !== undefined
          ) {
            this.matterAccessory ??= cachedAccessory;
          }
        }
      });

      // Initial deviceData is authoritative. Fill only absent declared fields,
      // preferring the established HAP cache before the Matter cache.
      let cachedDeviceData = [
        this.accessory?.context?.[this.constructor.PERSISTENCE_NAMESPACE],
        this.matterAccessory?.context?.[this.constructor.PERSISTENCE_NAMESPACE],
      ];
      this.#persistedFields.forEach((field) => {
        if (Object.hasOwn(this.deviceData, field) === false) {
          let source = cachedDeviceData.find(
            (data) =>
              typeof data === 'object' &&
              data !== null &&
              Array.isArray(data) === false &&
              Object.hasOwn(data, field) &&
              typeof data[field] !== 'undefined',
          );
          if (source !== undefined) {
            this.deviceData[field] = structuredClone(source[field]);
          }
        }
      });
    }
  }

  /**
   * Create, configure, and register the requested HAP and Matter representations.
   *
   * The subclass `onAdd` hook runs after base descriptors exist and before
   * Matter registration or independent HAP publication.
   *
   * @param {HomeKitDeviceAddOptions} [options={}] Representation and publication options.
   * @returns {Promise<boolean|undefined>} `true` when at least one representation is available,
   * `false` for a completed setup failure, or `undefined` when validation or a hook rejects setup.
   */
  async add(options = {}) {
    if (options === null || typeof options !== 'object' || options.constructor !== Object) {
      return;
    }

    if (
      this.backend === undefined ||
      typeof HomeKitDevice.PLUGIN_NAME !== 'string' || // Plugin name must be defined
      HomeKitDevice.PLUGIN_NAME === '' ||
      typeof HomeKitDevice.PLATFORM_NAME !== 'string' || // Platform name must be defined
      HomeKitDevice.PLATFORM_NAME === '' ||
      (options?.enableHistory !== undefined && typeof options?.enableHistory !== 'boolean') || // History flag must be boolean
      (options?.externalPublish !== undefined && typeof options?.externalPublish !== 'boolean') ||
      this.#validDeviceData(this.deviceData, true) === false // Device data failed validation (core + pairing if required)
    ) {
      return;
    }

    if (
      this.backend === HomeKitDevice.HAP_NODEJS &&
      (typeof options?.hapAccessoryName !== 'string' ||
        options.hapAccessoryName === '' ||
        typeof this.hap.Categories[options?.hapCategory] === 'undefined')
    ) {
      return;
    }

    // Copy only declared fields into the library owned context namespace.
    // Each representation receives its own data so neither shares mutable state.
    const persistedData = Object.fromEntries(
      this.#persistedFields
        .filter((field) => Object.hasOwn(this.deviceData, field))
        .map((field) => [field, this.deviceData[field]]),
    );

    // Homebridge needs at least one restored or creatable representation.
    if (
      this.backend === HomeKitDevice.HOMEBRIDGE &&
      this.accessory === undefined &&
      (this.hap === undefined ||
        options?.hapAccessoryName === null ||
        typeof this.#platform?.platformAccessory !== 'function' ||
        (options?.externalPublish === true
          ? typeof this.#platform?.publishExternalAccessories !== 'function'
          : typeof this.#platform?.registerPlatformAccessories !== 'function')) &&
      this.matterAccessory === undefined &&
      (this.matter === undefined ||
        typeof this.matter?.registerPlatformAccessories !== 'function' ||
        typeof options?.matterDeviceType !== 'object' ||
        options.matterDeviceType === null)
    ) {
      return;
    }

    if (this.accessory === undefined && this.backend === HomeKitDevice.HAP_NODEJS) {
      // Standalone HAP-NodeJS publishes its own Accessory instance.
      this.accessory = new this.hap.Accessory(options.hapAccessoryName, this.#uuid);
      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = options.hapCategory;
    }

    if (
      this.accessory === undefined &&
      this.backend === HomeKitDevice.HOMEBRIDGE &&
      this.hap !== undefined &&
      options?.hapAccessoryName !== null &&
      typeof this.#platform?.platformAccessory === 'function' &&
      (options?.externalPublish === true
        ? typeof this.#platform?.publishExternalAccessories === 'function'
        : typeof this.#platform?.registerPlatformAccessories === 'function')
    ) {
      // External accessories are configured by onAdd() before publication.
      // Bridged accessories retain the existing registration before onAdd flow.
      this.accessory = new this.#platform.platformAccessory(this.deviceData.description, this.#uuid, options?.hapCategory);
      if (Object.keys(persistedData).length !== 0) {
        this.accessory.context ??= {};
        this.accessory.context[this.constructor.PERSISTENCE_NAMESPACE] = structuredClone(persistedData);
      }
      if (options?.externalPublish !== true) {
        try {
          this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
        } catch (error) {
          this.accessory = undefined;
          this?.log?.warn?.('Failed to register HAP accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
        }
      }
    }

    // AccessoryInformation and EveHome are HAP-only concerns. Matter metadata
    // lives directly on the MatterAccessory descriptor and has no HAP service.
    if (this.accessory !== undefined) {
      let informationService = this.accessory.getService?.(this.hap.Service.AccessoryInformation);
      if (informationService === undefined) {
        this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
        this.accessory = undefined;
        this.historyService = undefined;
      } else {
        informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
        informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
        informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serialNumber);
        informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.softwareVersion);
        informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);

        if (typeof HomeKitDevice?.EVEHOME === 'function' && this.historyService === undefined && options?.enableHistory === true) {
          this.historyService = new HomeKitDevice.EVEHOME(this.accessory, this.hap, this.log, {});
        }
      }
    }

    if (
      this.matterAccessory === undefined &&
      this.backend === HomeKitDevice.HOMEBRIDGE &&
      this.matter !== undefined &&
      typeof options?.matterDeviceType === 'object' &&
      options.matterDeviceType !== null
    ) {
      // Create the minimum Matter representation before onAdd(), matching the
      // HAP lifecycle. The subclass adds clusters, handlers, parts, and state.
      this.matterAccessory = {
        UUID: this.#uuid,
        displayName: this.deviceData.description,
        deviceType: options.matterDeviceType,
        manufacturer: this.deviceData.manufacturer,
        model: this.deviceData.model,
        serialNumber: this.deviceData.serialNumber,
        firmwareRevision: this.deviceData.softwareVersion,
        context:
          Object.keys(persistedData).length === 0
            ? {}
            : { [this.constructor.PERSISTENCE_NAMESPACE]: structuredClone(persistedData) },
      };
    }

    // Lifecycle setup requires at least one usable protocol representation.
    // Do not call onAdd() when creation, restoration, or HAP validation left
    // the device without either representation.
    if (this.accessory === undefined && this.matterAccessory === undefined) {
      this.#postSetupDetails = [];
      this?.log?.error?.('No accessory is available for setup for "%s"', this.deviceData.description);
      return false;
    }

    this.postSetupDetail('Serial number "%s"', this.deviceData.serialNumber, LOG_LEVELS.DEBUG);
    this.postSetupDetail('Software version "%s"', this.deviceData.softwareVersion, LOG_LEVELS.DEBUG);

    // message() reports trapped handler failures so setup can stop cleanly.
    if ((await this.message(HomeKitDevice.ADD)) === false) {
      // These may be cached accessories supplied by Homebridge. Do not
      // unregister them as setup rollback; permanent removal belongs to remove().
      this.#postSetupDetails = [];
      this?.log?.error?.('Accessory setup failed for "%s"', this.deviceData.description);
      return;
    }

    // Register Matter only after onAdd() has completed the descriptor with its
    // clusters, handlers, parts, and initial state.
    if (typeof this.matterAccessory === 'object' && this.matterAccessory !== null) {
      if (
        this.backend === HomeKitDevice.HOMEBRIDGE &&
        typeof this.matter?.registerPlatformAccessories === 'function' &&
        this.matterAccessory.UUID === this.#uuid
      ) {
        try {
          await this.matter.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.matterAccessory]);
        } catch (error) {
          this.matterAccessory = undefined;
          this?.log?.warn?.('Failed to register Matter accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
        }
      } else {
        this.matterAccessory = undefined;
        this?.log?.warn?.('Matter accessory "%s" could not be registered', this.deviceData.description);
      }
    }

    if (this.accessory === undefined && this.matterAccessory === undefined) {
      this?.log?.error?.('No accessory was registered for "%s"', this.deviceData.description);
      this.#postSetupDetails = [];
      return false;
    }

    if (this.historyService?.EveHome !== undefined) {
      this.postSetupDetail('EveHome support as "%s"', this.historyService.EveHome.evetype);
    }

    // Trigger registered handlers (onUpdate + listeners) for initial device data updates
    await this.message(HomeKitDevice.UPDATE, this.deviceData, { force: true });

    // Publish HAP accessories that advertise independently, now that onAdd()
    // and the forced initial update have configured their services and state.
    // Homebridge publishes requested external accessories through its platform
    // API, while standalone HAP-NodeJS accessories publish themselves directly.
    if (
      this.accessory !== undefined &&
      ((options?.externalPublish === true &&
        this.backend === HomeKitDevice.HOMEBRIDGE &&
        this.accessory?._associatedPlatform === undefined) ||
        this.backend === HomeKitDevice.HAP_NODEJS)
    ) {
      try {
        if (this.backend === HomeKitDevice.HOMEBRIDGE) {
          this.#platform.publishExternalAccessories(HomeKitDevice.PLUGIN_NAME, [this.accessory]);
        } else {
          await this.accessory.publish({
            username: this.accessory.username,
            pincode: this.accessory.pincode,
            category: this.accessory.category,
          });

          this.postSetupDetail('Advertising as "%s"', this.accessory.displayName);
          this.postSetupDetail('Pairing code is "%s"', this.accessory.pincode);
        }
      } catch (error) {
        this.accessory = undefined;
        this.historyService = undefined;
        this?.log?.warn?.('Failed to publish HAP accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
        if (this.matterAccessory === undefined) {
          this.#postSetupDetails = [];
          return false;
        }
      }
    }

    this?.log?.success?.(...(typeof options?.hapAccessoryName === 'string' && options.hapAccessoryName !== '' ? ['Setup %s as "%s"', options.hapAccessoryName, this.deviceData.description] : ['Setup "%s"', this.deviceData.description]));
    this.#postSetupDetails.forEach((entry) => {
      let level =
        typeof entry === 'object' &&
        Object.hasOwn(LOG_LEVELS, entry?.level?.toUpperCase?.()) &&
        typeof this?.log?.[LOG_LEVELS[entry.level.toUpperCase()]] === 'function'
          ? LOG_LEVELS[entry.level.toUpperCase()]
          : LOG_LEVELS.INFO;
      this?.log?.[level]?.('  += ' + (entry?.message ?? entry), ...(Array.isArray(entry?.args) ? entry.args : []));
    });

    this.#postSetupDetails = []; // Don't need these anymore
    // Return a simple success flag: true when any valid accessory representation
    // is present, otherwise false.
    return this.accessory !== undefined || this.matterAccessory !== undefined;
  }

  /**
   * Permanently remove this device and release its protocol registrations and resources.
   *
   * @returns {Promise<void>}
   */
  async remove() {
    // Trigger registered handlers (onRemove + listeners)
    await this.message(HomeKitDevice.REMOVE);
  }

  /**
   * Broadcast the shutdown lifecycle event to every registered device.
   *
   * @returns {Promise<void>}
   */
  static async shutdown() {
    // Notify all registered devices of process shutdown.
    // Calls the instance shutdown() method on each registered device.
    for (let device of Array.from(HomeKitDevice.#deviceRegistry.values())) {
      try {
        await device.shutdown();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }
  }

  /**
   * Notify this device of shutdown and release its timers and listeners.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    // Trigger registered handlers (onShutdown + listeners)
    await this.message(HomeKitDevice.SHUTDOWN);
  }

  /**
   * Merge validated device data, synchronise shared metadata, and dispatch `onUpdate` when changed.
   *
   * @param {Partial<HomeKitDeviceData>} deviceData Partial or complete device data.
   * @param {...*} args Additional values forwarded to update hooks and registered handlers.
   * @returns {Promise<void>}
   */
  async update(deviceData, ...args) {
    if (
      deviceData === null || // Must not be null
      typeof deviceData !== 'object' || // Must be an object
      deviceData.constructor !== Object || // Must be a plain JSON object
      this.#validDeviceData(deviceData) === false // Partial validation
    ) {
      return;
    }

    // Trigger registered handlers (onUpdate + listeners)
    await this.message(HomeKitDevice.UPDATE, deviceData, ...args);
  }

  /**
   * Store an Eve-compatible history entry and notify hooks after the service accepts it.
   *
   * A missing or non-finite `entry.time` is replaced with the current epoch time in seconds.
   *
   * @param {object} target HAP service associated with the history entry; it must expose a UUID.
   * @param {Object<string, *>} entry History values to store.
   * @param {HomeKitHistoryOptions} [options={}] Duplicate and time-gap controls.
   * @returns {Promise<void>}
   */
  async history(target, entry, options = {}) {
    if (
      typeof this.historyService !== 'object' ||
      this.historyService === null ||
      typeof this.historyService.addHistory !== 'function' ||
      // entry must be a plain JSON object
      entry === null ||
      typeof entry !== 'object' ||
      entry.constructor !== Object ||
      // target must be a valid HomeKit service object
      typeof target !== 'object' ||
      target === null ||
      typeof target.UUID !== 'string' ||
      target.UUID === '' ||
      // options must be a plain JSON object
      options === null ||
      typeof options !== 'object' ||
      options.constructor !== Object
    ) {
      return;
    }

    // Trigger registered handlers (onHistory + listeners)
    await this.message(HomeKitDevice.HISTORY, target, entry, options);
  }

  /**
   * Dispatch a plain-object write request through the `SET` lifecycle route.
   *
   * @param {Object<string, *>} values Values requested by the caller.
   * @param {...*} args Additional values forwarded to set hooks and registered handlers.
   * @returns {Promise<void>}
   */
  async set(values, ...args) {
    if (
      values === null || // Must not be null
      typeof values !== 'object' || // Must be an object
      values.constructor !== Object // Must be a plain JSON object
    ) {
      return;
    }

    // Trigger registered handlers (onSet + listeners)
    await this.message(HomeKitDevice.SET, values, ...args);
  }

  /**
   * Dispatch a read request through the `GET` lifecycle route.
   *
   * @param {*} values Query supplied to get hooks and registered handlers.
   * @param {...*} args Additional values forwarded with the query.
   * @returns {Promise<*>} Hook result, merged object results, `false` on a trapped failure, or `undefined`.
   */
  async get(values, ...args) {
    // Trigger registered handlers (onGet + listeners)
    return this.message(HomeKitDevice.GET, values, ...args);
  }

  /**
   * Register a handler for a device message type or deliver a message by UUID.
   *
   * Passing a function registers it directly. Passing a non-plain object registers
   * its matching `on<Type>` method with that object as the call context. All other
   * values are delivered to the currently registered device instance.
   *
   * @param {string} uuid Target device UUID.
   * @param {string} type Message type, normally one of the class lifecycle constants.
   * @param {*|Function|object} [message] Listener, listener context, or message payload.
   * @param {...*} args Additional values forwarded during delivery.
   * @returns {Promise<*>} Delivery result, or `undefined` after registration or when no device matches.
   */
  static async message(uuid, type, message = undefined, ...args) {
    // This static entry point either registers a listener for a device UUID or
    // forwards a message to the matching live HomeKitDevice instance.
    if (typeof uuid !== 'string' || uuid === '' || typeof type !== 'string' || type === '') {
      return;
    }

    // A function registers directly as a listener. A non plain object registers
    // its matching on<Type>() method with that object retained as the context.
    // Plain objects and primitive values remain message payloads for delivery.
    if (typeof message === 'function' || (typeof message === 'object' && message !== null && message?.constructor !== Object)) {
      // Listener storage is created lazily because most UUID/type pairs have no
      // externally registered handlers.
      if (this.#listeners?.[uuid] === undefined) {
        this.#listeners[uuid] = {};
      }
      if (Array.isArray(this.#listeners[uuid][type]) === false) {
        this.#listeners[uuid][type] = [];
      }

      let handler, context;

      if (typeof message === 'function') {
        handler = message;
        context = undefined;
      } else {
        context = message;
        handler = typeof type === 'string' ? type.match(/\.?(on[A-Z][a-zA-Z0-9]*)$/)?.[1] : undefined;
      }

      // Avoid invoking the same handler/context pair more than once when a
      // host application discovers or registers the same device repeatedly.
      if (handler !== undefined) {
        if (this.#listeners?.[uuid]?.[type]?.find?.((h) => h.handler === handler && h.context === context) === undefined) {
          this.#listeners[uuid][type].push({ handler, context });
        }
      }

      return;
    }

    // Delivery is a no op when the UUID has no currently registered instance.
    return this.#deviceRegistry.get(uuid)?.message?.(type, message, ...args);
  }

  /**
   * Route a lifecycle or custom message through subclass hooks and registered handlers.
   *
   * Named hooks are invoked from the most-derived prototype toward base prototypes.
   * Object results from hooks and registered handlers are merged, with registered
   * handler fields taking precedence.
   *
   * @param {string} type Message type used to resolve the corresponding `on<Type>` hook.
   * @param {*} [message] Message payload.
   * @param {...*} args Additional values forwarded to hooks and registered handlers.
   * @returns {Promise<*>} Handler result, merged object results, `false` on a trapped failure, or `undefined`.
   */
  async message(type, message, ...args) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    if (
      (message === undefined || message === null) &&
      (type === HomeKitDevice.ADD || type === HomeKitDevice.UPDATE || type === HomeKitDevice.REMOVE || type === HomeKitDevice.SET)
    ) {
      // Normalise undefined or null message to empty object only for lifecycle types that expect object payloads
      message = {};
    }

    // Keep subclass hook and externally registered handler results separate until
    // dispatch completes. handled tracks routing, while failed records a trapped
    // handler error without preventing remaining cleanup or handlers from running.
    let result = { call: undefined, handler: undefined };
    let failed = false;
    let handled = false;
    let handler =
      Array.isArray(HomeKitDevice.#listeners?.[this.#uuid]?.[type]) === true
        ? HomeKitDevice.#listeners[this.#uuid][type]
        : HomeKitDevice.#listeners?.[this.#uuid]?.[type] !== undefined
          ? [HomeKitDevice.#listeners[this.#uuid][type]]
          : [];
    try {
      // Dynamically extract the handler method name from the type string (e.g., "HomeKitDevice.onAdd" becomes "onAdd")
      // This allows consistent routing to instance methods like onAdd, onSet, onUpdate, etc.
      let methodName = typeof type === 'string' ? type.match(/\.?(on[A-Z][a-zA-Z0-9]*)$/)?.[1] : undefined;

      // Invoke one hook source with error isolation. Named lifecycle hooks walk the
      // prototype chain so a subclass and its base classes can all participate.
      const callLifecycleHook = async (methodOrHandlers, ...params) => {
        let results = [];
        // Deduplicate the same function/context pair within this invocation while
        // retaining distinct overrides declared at different prototype levels.
        let called = [];
        let hooks =
          typeof methodOrHandlers === 'string'
            ? [{ handler: methodOrHandlers, context: this }]
            : Array.isArray(methodOrHandlers) === true
              ? methodOrHandlers[1] || []
              : [];

        for (let item of hooks) {
          let context = item?.context ?? this;
          let method = item?.handler;
          let current = context;
          let seen = new Set();
          let label =
            typeof method === 'string'
              ? (context?.constructor?.name ?? 'handler') + '.' + method
              : 'registered ' + methodOrHandlers[0];

          // Resolve named methods at each level after the preceding hook completes.
          // Every override retains the original receiver, including listener objects.
          while (current !== null && typeof current === 'object' && seen.has(current) === false) {
            seen.add(current);
            let fn = typeof method === 'string' ? current[method] : method;
            if (typeof fn === 'function' && called.some((call) => call.fn === fn && call.context === context) === false) {
              called.push({ fn, context });
              try {
                results.push(await fn.apply(context, params));
              } catch (error) {
                failed = true;
                this?.log?.warn?.('Error in %s(): %s', label, String(error?.stack || error));
              }
            }

            // Direct functions run once; named hooks continue through the live chain.
            current = typeof method === 'string' ? Object.getPrototypeOf(current) : undefined;
          }
        }

        // Preserve the historical scalar result for one handler; multiple hooks
        // return an ordered array matching their invocation order.
        return results.length === 1 ? results[0] : results;
      };

      // Snapshot the bridged HAP structure, metadata, and owned context that Homebridge persists
      // through its HAP updatePlatformAccessories() API. Matter is handled separately.
      const snapshotAccessoryCache = (accessory) => {
        let information = accessory?.getService?.(this.hap.Service.AccessoryInformation);
        return {
          displayName: accessory?.displayName,
          context: HomeKitDevice.#normaliseForCompare(
            accessory?.context?.[this.constructor.PERSISTENCE_NAMESPACE],
          ),
          information: Array.isArray(information?.characteristics)
            ? information.characteristics
                .map((characteristic) => ({
                  UUID: characteristic.UUID,
                  value: HomeKitDevice.#normaliseForCompare(characteristic.value),
                }))
                .sort((a, b) => a.UUID.localeCompare(b.UUID))
            : [],
          services: Array.isArray(accessory?.services)
            ? accessory.services
                .map((service) => ({
                  UUID: service.UUID,
                  subtype: service.subtype ?? '',
                  characteristics:
                    Array.isArray(service.characteristics) === true
                      ? service.characteristics.map((characteristic) => characteristic.UUID).sort()
                      : [],
                }))
                .sort((a, b) =>
                  a.UUID === b.UUID ? String(a.subtype).localeCompare(String(b.subtype)) : a.UUID.localeCompare(b.UUID),
                )
            : [],
        };
      };

      // Snapshot the cached, bridged HAP accessory before invoking message handlers.
      // External HAP and Matter accessories do not use this Homebridge cache update path.
      let originalAccessory =
        this.backend === HomeKitDevice.HOMEBRIDGE &&
        this.accessory !== undefined &&
        this.accessory?._associatedPlatform !== undefined &&
        typeof this.#platform?.updatePlatformAccessories === 'function'
          ? snapshotAccessoryCache(this.accessory)
          : [];

      // Handle built-in types with special behavior
      if (type === HomeKitDevice.ADD || type === HomeKitDevice.REMOVE || type === HomeKitDevice.SET) {
        // Call the dynamic on<Type> method (ie. onAdd, onRemove, onSet) and after
        // Any static handler registered via HomeKitDevice.message(uuid, type, handler)
        await callLifecycleHook(methodName, message, ...args);
        await callLifecycleHook(['handler for ' + type, handler], message, ...args);
        handled = true;

        // Special setup for ADD
        if (type === HomeKitDevice.ADD) {
          // After the accessory is initialised and onAdd has run, link or unlink any EveHome services
          for (let service of [...(this.accessory?.services || [])]) {
            let options = service?.[HomeKitDevice?.EVEHOME?.EVE_OPTIONS];
            if (options !== undefined) {
              delete service[HomeKitDevice?.EVEHOME?.EVE_OPTIONS];
            }

            // Link to EveHome if eveHistory is enabled.
            if (this.deviceData?.eveHistory === true && options !== undefined) {
              this?.historyService?.linkToEveHome?.(service, options);
            }

            // Otherwise unlink in case it was previously enabled and has now been disabled.
            if (this.deviceData?.eveHistory !== true) {
              for (let characteristic of [...(service.characteristics || [])]) {
                // EveHome history characteristics have UUIDs that start with E863F1 as defined in HomeKitHistory.js
                // If we find any, remove them from the service to unlink from EveHome
                if (characteristic?.UUID?.startsWith?.('E863F1') === true && typeof service?.removeCharacteristic === 'function') {
                  service.removeCharacteristic(characteristic);
                }
              }

              if (service?.UUID === this.hap.Service?.EveHomeHistory?.UUID) {
                this.accessory.removeService(service);
              }
            }
          }
        }

        // Special teardown for REMOVE
        if (type === HomeKitDevice.REMOVE) {
          this?.log?.warn?.('Notified to remove device "%s"', this.deviceData.description);

          // Clear any internal timers we have running for this device
          this.#clearTimers();

          // Cleanup all listeners and references to allow for garbage collection of this instance
          this?.removeAllListeners?.();
          HomeKitDevice.#deviceRegistry.delete(this.#uuid);
          delete HomeKitDevice.#listeners[this.#uuid];

          try {
            try {
              if (
                this.accessory !== undefined &&
                typeof this.#platform?.unregisterPlatformAccessories === 'function' &&
                (this.accessory?._associatedPlugin !== HomeKitDevice.PLUGIN_NAME ||
                  this.accessory?._associatedPlatform !== undefined)
              ) {
                await this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [
                  this.accessory,
                ]);
              }
            } finally {
              // Matter teardown must still run when HAP teardown fails.
              if (
                this.matterAccessory !== undefined &&
                typeof this.matter?.unregisterPlatformAccessories === 'function'
              ) {
                await this.matter.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [
                  this.matterAccessory,
                ]);
              }
            }
          } catch (error) {
            this?.log?.warn?.(
              'Failed to unregister accessory "%s": %s',
              this.deviceData.description,
              String(error?.stack || error),
            );
          }

          if (this.accessory !== undefined && this.#platform === undefined) {
            try {
              await this.accessory.unpublish();
            } catch (error) {
              this?.log?.warn?.(
                'Failed to unpublish HAP-NodeJS accessory "%s": %s',
                this.deviceData.description,
                String(error?.stack || error),
              );
            }
          }

          this.deviceData = {};
          this.accessory = undefined;
          this.matterAccessory = undefined;
          this.historyService = undefined;
          this.hap = undefined;
          this.matter = undefined;
          this.log = undefined;
          this.#uuid = undefined;
          this.#platform = undefined;
        }

        // Update the internal data for the set values, as could take some time once we emit the event
        if (type === HomeKitDevice.SET) {
          if (message !== null && typeof message === 'object' && message.constructor === Object) {
            Object.entries(message).forEach(([key, value]) => {
              if (this.deviceData?.[key] !== undefined) {
                this.deviceData[key] = value;
              }
            });
          }
        }
      } else if (type === HomeKitDevice.SHUTDOWN) {
        if (HomeKitDevice.#deviceRegistry.has(this.#uuid) === true) {
          // Deregister first so we don't get shutdown twice via global broadcaster
          HomeKitDevice.#deviceRegistry.delete(this.#uuid);
          delete HomeKitDevice.#listeners[this.#uuid];

          this?.log?.debug?.('Notifying device "%s" of shutdown', this.deviceData.description);

          // Now run shutdown hooks + cleanup
          await callLifecycleHook(methodName, message, ...args);
          await callLifecycleHook(['handler for ' + type, handler], message, ...args);

          // Clear any internal timers we have running for this device
          this.#clearTimers();
          this?.removeAllListeners?.();
        }
        handled = true;
      } else if (type === HomeKitDevice.UPDATE) {
        if (message !== null && typeof message === 'object' && message.constructor === Object) {
          let { merged, changed } = this.#mergeDeviceData(message);

          if (this.#validDeviceData(merged, true) !== true) {
            handled = true;
            return;
          }

          await this.#updateAccessoryMetadata(merged);

          if (changed === true || (typeof args?.[0] === 'object' && args?.[0]?.force === true)) {
            // Call the onUpdate method and after any static handler registered via HomeKitDevice.message(uuid, type, handler)
            await callLifecycleHook('onUpdate', merged, ...args);
            await callLifecycleHook(['handler for UPDATE', handler], merged, ...args);
          }

          // Update our internally stored data with the new data
          this.deviceData = structuredClone(merged);
        }
        handled = true;
      } else if (type === HomeKitDevice.HISTORY) {
        let [target, entry, options = {}] = [message, args[0], args[1]];
        let skipHistory = false;

        if (
          this.historyService !== null &&
          typeof this.historyService === 'object' &&
          typeof this.historyService?.addHistory === 'function' &&
          entry !== null &&
          typeof entry === 'object' &&
          entry.constructor === Object &&
          target !== null &&
          typeof target === 'object' &&
          typeof target.UUID === 'string' &&
          target.UUID !== '' &&
          options !== null &&
          typeof options === 'object' &&
          options.constructor === Object
        ) {
          // History expects epoch seconds. Mutate the caller's entry only when it
          // did not provide a finite timestamp so every accepted entry is dated.
          if (Number.isFinite(Number(entry?.time)) === false) {
            entry.time = Math.floor(Date.now() / 1000);
          }

          // Unless forced, compare all payload fields except time with the last
          // entry. Nested values are normalised to avoid key order false positives.
          if (options?.force !== true && typeof this.historyService?.lastHistory === 'function') {
            let last = this.historyService.lastHistory(target);
            if (typeof last === 'object') {
              let changed = Object.keys(entry).some((key) => {
                if (key === 'time') {
                  return false;
                }
                let value = entry[key];
                let lastValue = last[key];
                return value !== null && typeof value === 'object'
                  ? JSON.stringify(HomeKitDevice.#normaliseForCompare(value)) !==
                      JSON.stringify(HomeKitDevice.#normaliseForCompare(lastValue))
                  : value !== lastValue;
              });
              if (changed === false) {
                skipHistory = true;
              }
            }
          }

          if (skipHistory === false) {
            // EveHome owns time gap suppression; pass only a finite numeric value
            // and let the history service report whether it accepted the entry.
            let historyResult = await this.historyService.addHistory(
              target,
              entry,
              Number.isFinite(Number(options?.timegap)) === true ? Number(options.timegap) : undefined,
            );

            if (historyResult !== false) {
              // Notify hooks only after the entry was accepted by the history service.
              await callLifecycleHook('onHistory', target, entry, options);
              await callLifecycleHook(['handler for HISTORY', handler], target, entry, options);
            }
          }
        }

        handled = true;
      }

      // Dynamically handle any remaining on<Type> method (e.g., onGet etc that we haven’t handled yet)
      // Any static handler registered via HomeKitDevice.message(uuid, type, handler)
      if (handled === false && (typeof this?.[methodName] === 'function' || (Array.isArray(handler) === true && handler.length > 0))) {
        // Use string method name so we get inheritance merging;
        result.call = await callLifecycleHook(methodName, message, ...args);
        result.handler = await callLifecycleHook(['handler for ' + type, handler], message, ...args);
        handled = true;
      }

      // Call generic handler if present and we haven't handled the message yet
      if (handled === false && typeof this?.onMessage === 'function') {
        result.call = await callLifecycleHook('onMessage', type, message, ...args);
        handled = true;
      }

      if (
        this.backend === HomeKitDevice.HOMEBRIDGE &&
        this.accessory !== undefined &&
        this.accessory?._associatedPlatform !== undefined &&
        typeof this.#platform?.updatePlatformAccessories === 'function'
      ) {
        // Check whether the bridged HAP structure or metadata changed.
        let updatedAccessory = snapshotAccessoryCache(this.accessory);
        if (JSON.stringify(originalAccessory) !== JSON.stringify(updatedAccessory)) {
          // Persist the changed HAP accessory in Homebridge's platform cache.
          this.#platform.updatePlatformAccessories([this.accessory]);
        }
      }

      // No handler at all, including onMessage().
      if (handled === false && (Array.isArray(handler) === false || handler.length === 0) && typeof this?.[methodName] !== 'function') {
        this?.log?.debug?.('Unhandled message type "%s" for device "%s"', type, this.deviceData.description);
      }

      if (failed === true) {
        // A trapped hook failure is the public failure signal, even though later
        // handlers and required lifecycle cleanup were still allowed to complete.
        return false;
      }

      if (typeof result.call === 'object' || typeof result.handler === 'object') {
        // Object results form one response; registered handler fields win when
        // both sources provide the same key because they are assigned last.
        return Object.assign({}, result.call ?? {}, result.handler ?? {});
      }
    } catch (error) {
      this?.log?.warn?.(
        'Unhandled error while processing message "%s" for device "%s": %s',
        type,
        this.deviceData?.description,
        typeof error?.stack === 'string' ? error.stack : String(error),
      );
      return false;
    }
    return result.call !== undefined ? result.call : result.handler;
  }

  /**
   * Register a named one-shot, repeating, or delayed repeating timer.
   *
   * When no callback is supplied, each invocation dispatches a `TIMER` message
   * containing the timer handle and configured message fields.
   *
   * @param {string} timerHandle Device-scoped timer name.
   * @param {HomeKitTimerOptions} [options={}] Timer schedule and payload.
   * @param {HomeKitTimerCallback} [callback] Direct callback used instead of message dispatch.
   * @returns {boolean} `true` when the timer exists after the call, otherwise `false`.
   */
  addTimer(timerHandle, options = {}, callback = undefined) {
    // Register a timer (timeout, interval, or both) that either calls a callback or dispatches via message system
    // Supports three patterns:
    //   - delay only: fires once after delay (e.g., motion cooldown)
    //   - interval only: fires repeatedly (e.g., periodic polling)
    //   - delay + interval: fires once after delay, then repeats (e.g., initial delay before polling)
    // Returns true if timer was added, false if invalid parameters or duplicate (use reset:true to replace)
    if (typeof timerHandle !== 'string' || timerHandle === '') {
      return false;
    }

    if (options === null || typeof options !== 'object' || options.constructor !== Object) {
      options = {};
    }

    let delay = Number.isFinite(Number(options?.delay)) && Number(options.delay) > 0 ? Number(options.delay) : 0;
    let interval = Number.isFinite(Number(options?.interval)) && Number(options.interval) > 0 ? Number(options.interval) : 0;
    let reset = options?.reset === true;
    let timerMessage =
      typeof options?.message === 'object' && options.message !== null && options.message.constructor === Object ? options.message : {};

    // Nothing to schedule
    if (delay === 0 && interval === 0) {
      return false;
    }

    // Extend/reset existing timer (eg. motion cooldown)
    if (reset === true) {
      this.removeTimer(timerHandle);
    }

    // If we didn't reset and one exists, keep it
    if (reset === false && this.#timers.has(timerHandle) === true) {
      return true;
    }

    let entry = {
      delay: delay,
      interval: interval,
      timeout: undefined,
      intervalHandle: undefined,
      started: Date.now(),
      message: timerMessage,
      callback: typeof callback === 'function' ? callback : undefined,
      running: false,
      cancelled: false,
    };

    let fire = (removeAfterRun = false) => {
      // Prevent overlapping timer executions and ignore cancelled timers
      if (entry.running === true || entry.cancelled === true) {
        return;
      }

      entry.running = true;

      // Invoke inside the promise chain so synchronous throws also reach cleanup.
      Promise.resolve()
        .then(() =>
          typeof entry.callback === 'function'
            ? entry.callback(timerHandle, entry.message)
            : this.message(HomeKitDevice.TIMER, {
                timer: timerHandle,
                ...entry.message,
              }),
        )
        .catch(() => {
          // Empty
        })
        .finally(() => {
          if (entry.cancelled === true) {
            return;
          }

          entry.running = false;

          if (removeAfterRun === true) {
            this.removeTimer(timerHandle);
          }
        });
    };

    // delay only => fire once
    if (delay > 0 && interval === 0) {
      entry.timeout = setTimeout(() => {
        entry.timeout = undefined;
        fire(true);
      }, delay);

      this.#timers.set(timerHandle, entry);
      return true;
    }

    // interval only => repeat
    if (delay === 0 && interval > 0) {
      entry.intervalHandle = setInterval(() => {
        fire();
      }, interval);

      this.#timers.set(timerHandle, entry);
      return true;
    }

    // delay + interval => fire once after delay, then repeat
    entry.timeout = setTimeout(() => {
      entry.timeout = undefined;
      fire();

      // A synchronous first callback may remove or replace this timer. Do not
      // create an interval that is no longer owned by the timer registry.
      if (entry.cancelled === true || this.#timers.get(timerHandle) !== entry) {
        return;
      }

      entry.intervalHandle = setInterval(() => {
        fire();
      }, interval);
    }, delay);

    this.#timers.set(timerHandle, entry);
    return true;
  }

  /**
   * Cancel and remove a named timer.
   *
   * @param {string} timerHandle Device-scoped timer name.
   * @returns {boolean} `true` when the handle is valid, including when already absent; otherwise `false`.
   */
  removeTimer(timerHandle) {
    // Clear a timer by handle. Returns true even if timer doesn't exist (idempotent, safe to call multiple times)
    if (typeof timerHandle !== 'string' || timerHandle === '') {
      return false;
    }

    if (this.#timers.has(timerHandle) === false) {
      return true;
    }

    let entry = this.#timers.get(timerHandle);

    // Mark as cancelled so any in-flight async completion knows it's no longer valid
    entry.cancelled = true;

    try {
      clearTimeout(entry?.timeout);
      clearInterval(entry?.intervalHandle);
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Empty
    }

    // Defensive cleanup
    entry.timeout = undefined;
    entry.intervalHandle = undefined;
    entry.running = false;

    this.#timers.delete(timerHandle);
    return true;
  }

  /**
   * Test whether a named timer is currently registered.
   *
   * @param {string} timerHandle Device-scoped timer name.
   * @returns {boolean} Whether the timer is registered.
   */
  hasTimer(timerHandle) {
    // Check if a timer with this handle is currently active/registered
    if (typeof timerHandle !== 'string' || timerHandle === '') {
      return false;
    }

    return this.#timers.has(timerHandle) === true;
  }

  /**
   * Resolve or create a HAP service and optionally defer its Eve configuration.
   *
   * @param {Function|object} serviceType HAP service constructor or service type accepted by the runtime.
   * @param {string} [name=''] Display name used when a service is created.
   * @param {string} [subType] Stable subtype used to distinguish services of the same type.
   * @param {Object<string, *>} [eveOptions] Options passed to the Eve history integration after setup.
   * @returns {object|undefined} Existing or newly created HAP service.
   */
  addService(serviceType, name = '', subType = undefined, eveOptions = undefined) {
    let service = undefined;

    // Work only with a HAP accessory exposing every lookup and creation method
    // needed by this helper. Matter-only devices therefore return undefined
    // without requiring callers to add a separate protocol guard.
    if (
      serviceType !== undefined &&
      typeof this?.accessory?.getService === 'function' &&
      typeof this?.accessory?.getServiceById === 'function' &&
      typeof this?.accessory?.addService === 'function'
    ) {
      // A subtype identifies one of several services with the same type. Without
      // one, reuse the accessory's primary service of that type.
      if (subType !== undefined) {
        service = this.accessory.getServiceById(serviceType, subType);
      } else {
        service = this.accessory.getService(serviceType);
      }

      // Create only when lookup found no match, making repeated setup idempotent.
      if (service === undefined) {
        service = this.accessory.addService(serviceType, name, subType);
      }

      // Retain Eve configuration on the resolved service. add() links it only
      // after onAdd() has finished building the complete HAP representation.
      if (service !== undefined && eveOptions !== null && typeof eveOptions === 'object' && eveOptions.constructor === Object) {
        service[HomeKitDevice?.EVEHOME?.EVE_OPTIONS] = eveOptions;
      }
    }

    return service;
  }

  /**
   * Remove a HAP service instance or a service resolved from its type and subtype.
   *
   * @param {object|Function} serviceOrType Existing HAP service or service type.
   * @param {string} [subType] Subtype used when resolving a service type.
   * @returns {boolean} `true` when a service was removed.
   */
  removeService(serviceOrType, subType = undefined) {
    let service = undefined;

    // Callers may pass either the concrete service returned by addService() or a
    // service constructor to resolve. instanceof is guarded because Matter-only
    // devices and incomplete HAP stubs do not expose the Service base class.
    let isServiceInstance = typeof this?.hap?.Service === 'function' && serviceOrType instanceof this.hap.Service;

    // A missing HAP accessory is a safe no-op rather than an exceptional path.
    if (typeof this?.accessory?.removeService !== 'function') {
      return false;
    }

    // An instance already identifies the exact service and avoids another lookup.
    if (isServiceInstance === true) {
      service = serviceOrType;
    } else if (
      serviceOrType !== undefined &&
      typeof this?.accessory?.getService === 'function' &&
      typeof this?.accessory?.getServiceById === 'function'
    ) {
      // Resolve by subtype when several services share a type; otherwise target
      // the accessory's primary service of that type.
      if (subType !== undefined) {
        service = this.accessory.getServiceById(serviceOrType, subType);
      } else {
        service = this.accessory.getService(serviceOrType);
      }
    }

    // Report absence explicitly so callers can distinguish it from removal.
    if (service === undefined) {
      return false;
    }

    // Delegate structural cleanup to HAP and report that a service was removed.
    this.accessory.removeService(service);
    return true;
  }

  /**
   * Resolve or add a HAP characteristic, then apply its handlers, properties, and initial value.
   *
   * @param {object} service HAP service receiving the characteristic.
   * @param {Function|object} characteristicType HAP characteristic constructor or type.
   * @param {HomeKitCharacteristicOptions} [options={}] Characteristic behavior and metadata.
   * @returns {object|undefined} Resolved HAP characteristic.
   */
  addCharacteristic(service, characteristicType, { props, onSet, onGet, initialValue } = {}) {
    let characteristic = undefined;

    // Work only with a HAP service like object exposing the complete surface this
    // helper needs. Returning undefined keeps the method safe for absent HAP
    // representations and prevents partially configuring an incompatible object.
    if (
      characteristicType !== undefined &&
      typeof service?.getCharacteristic === 'function' &&
      typeof service?.testCharacteristic === 'function' &&
      typeof service?.addCharacteristic === 'function' &&
      typeof service?.addOptionalCharacteristic === 'function'
    ) {
      // Reuse an existing characteristic. If it is merely advertised as optional,
      // use HAP's optional path so the service creates it with the correct metadata.
      if (service.testCharacteristic(characteristicType) === false) {
        if (
          Array.isArray(service?.optionalCharacteristics) === true &&
          service.optionalCharacteristics.includes(characteristicType) === true
        ) {
          service.addOptionalCharacteristic(characteristicType);
        } else {
          service.addCharacteristic(characteristicType);
        }
      }

      // Resolve the single existing or new instance before attaching any behavior.
      characteristic = service.getCharacteristic(characteristicType);

      // Bind HomeKit writes and reads only when the caller supplied handlers.
      if (typeof onSet === 'function') {
        characteristic.onSet(onSet);
      }
      if (typeof onGet === 'function') {
        characteristic.onGet(onGet);
      }

      // Characteristic constraints such as range, step, unit, and valid values
      // belong to the characteristic instance rather than the containing service.
      if (props !== null && typeof props === 'object' && props.constructor === Object && typeof characteristic.setProps === 'function') {
        characteristic.setProps(props);
      }

      // Initialise through the service API so HAP updates its characteristic value
      // without treating setup as a controller originated onSet operation.
      if (typeof initialValue !== 'undefined' && typeof service?.updateCharacteristic === 'function') {
        service.updateCharacteristic(characteristicType, initialValue);
      }
    }

    return characteristic;
  }

  /**
   * Add or extend a declarative cluster on the pending Matter accessory descriptor.
   *
   * Repeated calls merge attributes and command handlers for the same cluster.
   *
   * @param {string} clusterName Matter cluster descriptor key.
   * @param {HomeKitMatterClusterOptions} [options={}] Initial attributes and command handlers.
   * @returns {Object<string, *>|undefined} Merged initial state, or `undefined` without a Matter descriptor.
   */
  addMatterCluster(clusterName, { initialState, handlers } = {}) {
    // Matter cluster names are descriptor keys, and configuration requires the
    // root Matter descriptor created or restored before onAdd() runs.
    if (
      typeof clusterName !== 'string' ||
      clusterName === '' ||
      typeof this.matterAccessory !== 'object' ||
      this.matterAccessory === null
    ) {
      return;
    }

    // Reuse previously declared attributes and overlay supplied initial state so
    // separate setup steps can extend one cluster without discarding each other.
    let currentClusters =
      typeof this.matterAccessory.clusters === 'object' && this.matterAccessory.clusters !== null
        ? this.matterAccessory.clusters
        : {};
    let currentState =
      typeof currentClusters[clusterName] === 'object' && currentClusters[clusterName] !== null
        ? currentClusters[clusterName]
        : {};
    let nextState =
      initialState !== null && typeof initialState === 'object' && initialState.constructor === Object
        ? { ...currentState, ...initialState }
        : { ...currentState };

    // Matter descriptors are declarative. Replacing the containers keeps repeated
    // helper calls predictable while preserving state already declared for a cluster.
    this.matterAccessory.clusters = { ...currentClusters, [clusterName]: nextState };

    if (handlers !== null && typeof handlers === 'object' && handlers.constructor === Object) {
      // Commands are keyed beneath the same cluster name. Merge them independently
      // from attributes because one cluster commonly declares several commands.
      let currentHandlers =
        typeof this.matterAccessory.handlers === 'object' && this.matterAccessory.handlers !== null
          ? this.matterAccessory.handlers
          : {};
      let clusterHandlers =
        typeof currentHandlers[clusterName] === 'object' && currentHandlers[clusterName] !== null
          ? currentHandlers[clusterName]
          : {};
      this.matterAccessory.handlers = {
        ...currentHandlers,
        [clusterName]: { ...clusterHandlers, ...handlers },
      };
    }

    return nextState;
  }

  /**
   * Remove a HAP characteristic instance or resolve one from its type without creating it.
   *
   * @param {object} service HAP service containing the characteristic.
   * @param {object|Function} characteristicOrType Existing characteristic or characteristic type.
   * @returns {boolean} `true` when a characteristic was removed.
   */
  removeCharacteristic(service, characteristicOrType) {
    let characteristic = undefined;

    // Accept either the instance returned by addCharacteristic() or a
    // characteristic constructor. Guard instanceof for runtimes without HAP.
    let isCharacteristicInstance =
      typeof this?.hap?.Characteristic === 'function' && characteristicOrType instanceof this.hap.Characteristic;

    // Removal requires both the HAP operation and the service's current list so a
    // type can be resolved without invoking a lookup that may mutate the service.
    if (typeof service?.removeCharacteristic !== 'function' || Array.isArray(service?.characteristics) !== true) {
      return false;
    }

    // An instance already identifies the exact characteristic to remove.
    if (isCharacteristicInstance === true) {
      characteristic = characteristicOrType;
    } else if (characteristicOrType !== undefined) {
      // Match by UUID instead of getCharacteristic(), because HAP may create an
      // optional characteristic as a side effect of that getter.
      characteristic = service.characteristics.find((entry) => entry?.UUID === characteristicOrType?.UUID);
    }

    // Report absence explicitly so callers can distinguish it from removal.
    if (characteristic === undefined) {
      return false;
    }

    // Delegate list and event cleanup to HAP, then confirm removal to the caller.
    service.removeCharacteristic(characteristic);
    return true;
  }

  /**
   * Queue a formatted detail for the successful setup summary.
   *
   * A recognised final `info`, `success`, `warn`, `error`, or `debug` argument
   * selects the log level and is not passed as a formatting value.
   *
   * @param {string} message Logger format string.
   * @param {...*} args Format values, optionally followed by a log-level string.
   * @returns {void}
   */
  postSetupDetail(message, ...args) {
    // Ignore invalid or empty messages so the deferred setup summary contains
    // only entries that can be passed safely to the configured logger.
    if (typeof message !== 'string' || message === '') {
      return;
    }

    // Details default to info. A recognised trailing level is control metadata,
    // not a message format argument, so remove it from the stored argument list.
    let levelKey = 'INFO';
    let lastArg = args.at(-1);

    if (typeof lastArg === 'string' && Object.hasOwn(LOG_LEVELS, lastArg.toUpperCase()) === true) {
      levelKey = lastArg.toUpperCase();
      args = args.slice(0, -1);
    }

    // Queue details instead of logging immediately so add() can emit them as one
    // grouped summary after setup succeeds and discard them after a fatal failure.
    this.#postSetupDetails.push({
      level: LOG_LEVELS[levelKey], // 'info', 'debug', etc.
      message,
      args: args.length > 0 ? args : undefined,
    });
  }

  /**
   * Generate the stable UUID used to identify a device.
   *
   * @param {string} pluginName Homebridge plugin name.
   * @param {object} api Homebridge or HAP-NodeJS API exposing a UUID generator.
   * @param {string} serialNumber Device serial number.
   * @returns {string} Generated device UUID.
   * @throws {TypeError} When an identifier is empty or no runtime UUID can be generated.
   */
  static generateUUID(pluginName, api, serialNumber) {
    if (typeof pluginName !== 'string' || pluginName === '' || typeof serialNumber !== 'string' || serialNumber === '') {
      throw new TypeError('Unable to generate accessory UUID');
    }

    // Prefer HAP so enabling Matter cannot change an existing identity. Matter's
    // UUID API is its alias; direct HAP-NodeJS exposes the API at the root.
    let uuid = (api?.hap?.uuid ?? api?.matter?.uuid ?? api?.uuid)?.generate?.(
      pluginName + '_' + serialNumber.toUpperCase(),
    );
    if (typeof uuid !== 'string' || uuid === '') {
      throw new TypeError('Unable to generate accessory UUID');
    }
    return uuid;
  }

  /**
   * Remove characters that HomeKit does not accept at the start, middle, or end of a name.
   *
   * @param {*} name Candidate name. Non-string values are returned unchanged.
   * @returns {*} Sanitised name, `Unknown Device` for an empty sanitised string, or the original non-string value.
   */
  static makeValidHKName(name) {
    // Strip invalid characters to meet HomeKit naming requirements.
    // Ensure names start and end with a Unicode letter or number.
    // Allow letters, numbers, space like characters, apostrophes,
    // and common punctuation only in the middle of the string.
    // Use \p{Zs} instead of \p{Z} to avoid line/paragraph separators.
    // Home app validation rejects names ending in apostrophes,
    // including U+2019 (curly apostrophe).

    return typeof name === 'string'
      ? (name
          .replace(/[^\p{L}\p{N}\p{Zs}\u2019'&!._:;()\/,-]/gu, '')
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
          .trim() || 'Unknown Device')
      : name;
  }

  /**
   * Return the deterministic identity shared by this device's protocol representations.
   *
   * @returns {string|undefined} Device UUID, or `undefined` after permanent removal.
   */
  get uuid() {
    return this.#uuid;
  }

  /**
   * Produce a recursively key-sorted value suitable for stable JSON comparison.
   *
   * @param {*} value Value to normalise.
   * @returns {*} Normalised value with array order preserved and `undefined` represented explicitly.
   * @private
   */
  static #normaliseForCompare(value) {
    // Normalise values before comparison so JSON.stringify is stable:
    // - object keys are sorted recursively to avoid false positives from key order
    // - arrays retain their order
    // - undefined is converted to a string placeholder so it is not dropped
    return Array.isArray(value) === true
      ? value.map((entry) => HomeKitDevice.#normaliseForCompare(entry))
      : typeof value === 'object' && value !== null
        ? Object.keys(value)
            .sort()
            .reduce((result, key) => {
              result[key] = HomeKitDevice.#normaliseForCompare(value[key] === undefined ? 'undefined' : value[key]);
              return result;
            }, {})
        : value === undefined
          ? 'undefined'
          : value;
  }

  /**
   * Overlay partial updates on current device data and detect semantic changes.
   *
   * @param {Partial<HomeKitDeviceData>} [deviceDataUpdates={}] Validated partial device data.
   * @returns {{merged: HomeKitDeviceData, changed: boolean}} Complete merged data and its change flag.
   * @private
   */
  #mergeDeviceData(deviceDataUpdates = {}) {
    let merged = { ...deviceDataUpdates };

    // Updated data may only contain selected fields, so merge with our internally stored
    // data to ensure we always end up with a complete deviceData object.
    Object.entries(this.deviceData).forEach(([key, value]) => {
      if (typeof merged[key] === 'undefined') {
        merged[key] = value;
      }
    });

    // Check updated device data with our internally stored data and flag if changes exist.
    // This compares the full merged view rather than only the incoming partial update.
    let changed = Object.keys(merged).some(
      (key) =>
        JSON.stringify(HomeKitDevice.#normaliseForCompare(merged[key])) !==
        JSON.stringify(HomeKitDevice.#normaliseForCompare(this.deviceData[key])),
    );

    return { merged, changed };
  }

  /**
   * Synchronise common metadata and declared persisted fields across active representations.
   *
   * @param {HomeKitDeviceData} deviceData Complete validated device data.
   * @returns {Promise<void>}
   * @private
   */
  async #updateAccessoryMetadata(deviceData) {
    // Synchronise common metadata across the available HAP and Matter representations.
    // The merged device data is fully validated before this method is called.
    if (deviceData.serialNumber.toUpperCase() !== this.deviceData.serialNumber?.toUpperCase()) {
      this?.log?.warn?.('Serial number on "%s" has changed', deviceData.description);
      this?.log?.warn?.('This may cause the device to become unresponsive in HomeKit or Matter');
    }

    // HAP stores common metadata as characteristics on AccessoryInformation.
    // Matter only devices have no HAP accessory, so no service is resolved.
    let informationService = this.accessory?.getService?.(this.hap.Service.AccessoryInformation);
    if (this.accessory !== undefined && informationService === undefined) {
      this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
    }

    // Each entry maps one validated device value to its HAP characteristic and
    // Matter descriptor property so both representations use the same source.
    let metadata = [
      [deviceData.description, this.hap?.Characteristic?.Name, 'displayName'],
      [deviceData.manufacturer, this.hap?.Characteristic?.Manufacturer, 'manufacturer'],
      [deviceData.model, this.hap?.Characteristic?.Model, 'model'],
      [deviceData.serialNumber, this.hap?.Characteristic?.SerialNumber, 'serialNumber'],
      [deviceData.softwareVersion, this.hap?.Characteristic?.FirmwareRevision, 'firmwareRevision'],
    ];

    // Matter descriptor changes are applied optimistically. Retain each original
    // property until the single batched cache update succeeds so only Matter can
    // be rolled back on failure; live HAP characteristic updates remain applied.
    let previous = new Map();

    for (let [value, characteristic, property] of metadata) {
      // HAP characteristic values update the live accessory immediately.
      if (informationService !== undefined && informationService.getCharacteristic(characteristic)?.value !== value) {
        informationService.updateCharacteristic(characteristic, value);
      }

      // The HAP accessory name is also held outside AccessoryInformation.
      if (property === 'displayName' && informationService !== undefined && this.accessory.displayName !== value) {
        this.accessory.displayName = value;
      }

      // Matter metadata lives directly on its cached accessory descriptor.
      if (
        typeof this.matterAccessory === 'object' &&
        this.matterAccessory !== null &&
        this.matterAccessory[property] !== value
      ) {
        previous.set(property, {
          exists: Object.hasOwn(this.matterAccessory, property),
          value: this.matterAccessory[property],
        });
        this.matterAccessory[property] = value;
      }
    }

    // FirmwareRevision supersedes the legacy HAP SoftwareRevision value.
    if (informationService?.testCharacteristic(this.hap.Characteristic.SoftwareRevision) === true) {
      this.removeCharacteristic(informationService, this.hap.Characteristic.SoftwareRevision);
    }

    // Keep declared device data in each available representation's owned context.
    // HAP persistence is handled by the surrounding cache snapshot; Matter joins
    // the pending metadata changes in the same updatePlatformAccessories() call.
    if (this.#persistedFields.length !== 0) {
      let persistedData = Object.fromEntries(
        this.#persistedFields
          .filter((field) => Object.hasOwn(deviceData, field))
          .map((field) => [field, deviceData[field]]),
      );
      let persistedState = JSON.stringify(HomeKitDevice.#normaliseForCompare(persistedData));

      if (
        this.accessory !== undefined &&
        JSON.stringify(
          HomeKitDevice.#normaliseForCompare(
            this.accessory?.context?.[this.constructor.PERSISTENCE_NAMESPACE],
          ),
        ) !== persistedState
      ) {
        this.accessory.context ??= {};
        this.accessory.context[this.constructor.PERSISTENCE_NAMESPACE] = structuredClone(persistedData);
      }

      if (
        this.matterAccessory !== undefined &&
        JSON.stringify(
          HomeKitDevice.#normaliseForCompare(
            this.matterAccessory?.context?.[this.constructor.PERSISTENCE_NAMESPACE],
          ),
        ) !== persistedState
      ) {
        previous.set('context', {
          exists: Object.hasOwn(this.matterAccessory, 'context'),
          value: structuredClone(this.matterAccessory.context),
        });
        this.matterAccessory.context ??= {};
        this.matterAccessory.context[this.constructor.PERSISTENCE_NAMESPACE] = structuredClone(persistedData);
      }
    }

    // Persist all changed Matter metadata and context in one update after applying it.
    if (previous.size !== 0 && typeof this.matter?.updatePlatformAccessories === 'function') {
      try {
        await this.matter.updatePlatformAccessories([this.matterAccessory]);
      } catch (error) {
        // Restore the last cached representation so a later update can retry.
        previous.forEach((entry, key) => {
          if (entry.exists === true) {
            this.matterAccessory[key] = entry.value;
          } else {
            delete this.matterAccessory[key];
          }
        });
        this?.log?.warn?.(
          'Failed to update Matter accessory metadata for "%s": %s',
          deviceData.description,
          String(error?.stack || error),
        );
      }
    }

    if (typeof deviceData?.online === 'boolean' && deviceData.online !== this.deviceData.online) {
      // Device online status has changed. Log and send message to trigger any handlers for this change
      if (deviceData.online === false) {
        this?.log?.warn?.('Device "%s" is offline', deviceData.description);
        await this.message(HomeKitDevice.OFFLINE);
      }

      if (deviceData.online === true) {
        this?.log?.success?.('Device "%s" is online', deviceData.description);
        await this.message(HomeKitDevice.ONLINE);
      }
    }
  }

  /**
   * Validate core metadata and standalone HAP pairing fields.
   *
   * @param {Partial<HomeKitDeviceData>} [deviceData={}] Device data to validate.
   * @param {boolean} [strict=false] Require a complete record even when only some core fields are present.
   * @returns {boolean} Whether the supplied data satisfies the applicable contract.
   * @private
   */
  #validDeviceData(deviceData = {}, strict = false) {
    if (
      deviceData === null || // Must not be null
      typeof deviceData !== 'object' || // Must be an object
      deviceData.constructor !== Object // Must be a plain JSON object
    ) {
      return false;
    }

    let keys = ['serialNumber', 'softwareVersion', 'description', 'model', 'manufacturer'];
    // Strict callers require a complete record. A payload containing every core
    // field is also treated as complete; otherwise it is validated as a partial
    // update and only supplied fields are checked.
    let isFull = strict === true || keys.every((key) => typeof deviceData[key] !== 'undefined');

    for (let key of keys) {
      if (isFull === true) {
        // Full validation: required fields must exist and be valid
        if (typeof deviceData[key] !== 'string' || deviceData[key] === '') {
          return false;
        }
      }

      if (isFull === false && typeof deviceData[key] !== 'undefined') {
        // Partial update: only validate fields that are present
        if (typeof deviceData[key] !== 'string' || deviceData[key] === '') {
          return false;
        }
      }
    }

    // Pairing validation for HAP-NodeJS only, where no Homebridge platform is present.
    if (this.#platform === undefined) {
      let hasPairing = typeof deviceData?.hkPairingCode !== 'undefined' || typeof deviceData?.hkUsername !== 'undefined';

      if (isFull === true) {
        // Full validation: pairing details must be present and valid
        if (
          typeof deviceData?.hkPairingCode !== 'string' ||
          (HomeKitDevice.HK_PIN_3_2_3.test(deviceData.hkPairingCode) === false &&
            HomeKitDevice.HK_PIN_4_4.test(deviceData.hkPairingCode) === false) ||
          typeof deviceData?.hkUsername !== 'string' ||
          HomeKitDevice.MAC_ADDR.test(deviceData.hkUsername) === false // Must be valid MAC address format (XX:XX:XX:XX:XX:XX)
        ) {
          return false;
        }
      }

      if (isFull === false && hasPairing === true) {
        // Partial update: only validate pairing fields if provided
        if (
          typeof deviceData?.hkPairingCode !== 'undefined' &&
          (typeof deviceData.hkPairingCode !== 'string' ||
            (HomeKitDevice.HK_PIN_3_2_3.test(deviceData.hkPairingCode) === false &&
              HomeKitDevice.HK_PIN_4_4.test(deviceData.hkPairingCode) === false))
        ) {
          return false;
        }

        if (
          typeof deviceData?.hkUsername !== 'undefined' &&
          (typeof deviceData.hkUsername !== 'string' || HomeKitDevice.MAC_ADDR.test(deviceData.hkUsername) === false) // Validate MAC format if username is supplied
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Cancel every timer owned by this device.
   *
   * @returns {void}
   * @private
   */
  #clearTimers() {
    // Clear all internal timers for this device
    // Snapshot keys first to avoid mutating the Map while iterating
    for (let timerHandle of [...this.#timers.keys()]) {
      this.removeTimer(timerHandle);
    }
  }
}
