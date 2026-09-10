// Base Class: HomeKitDevice
//
// Shared base class for HomeKit-enabled devices across multiple projects.
// Supports the Homebridge runtime (HAP and optional Matter) and the direct
// HAP-NodeJS runtime.
//
// Provides a unified abstraction layer that standardises accessory creation,
// lifecycle handling, message routing, timer management, and optional
// EveHome history support across all device types.
//
// Responsibilities:
// - Manage HomeKit accessory creation and removal
// - Provide unified message routing for device lifecycle and custom events
// - Maintain internal device registry -> cross-device messaging
// - Standardise HomeKit service and characteristic helper methods
// - Integrate optional EveHome-compatible history support
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
// - addService() / addCharacteristic()
//     -> simplified HomeKit setup helpers
// - addTimer() / removeTimer() / hasTimer()
//     -> per-device timer management
// - history()
//     -> EveHome-compatible history logging and hook dispatch
// - Static device registry
//     -> enables global device message routing
//
// Architecture:
// - Designed to be extended per device type (e.g. Camera, Thermostat, Valve)
// - Operates as the abstraction layer between raw device data and HomeKit
// - Can run under Homebridge or standalone HAP-NodeJS environments
//
// Example:
//
// class MyDevice extends HomeKitDevice {
//   async onAdd() {
//     let service = this.addService(this.hap.Service.Switch, this.deviceData.description);
//   }
// }
//
// HomeKitDevice.LOGGER = log;
// let device = new MyDevice(undefined, hap, deviceData);
// await device.add({ hapAccessoryName: 'My Device', hapCategory: hap.Categories.SWITCH });
//
// Notes:
// - Designed for subclassing only
// - Supports both Homebridge and HAP-NodeJS backends
// - Homebridge platform shutdown and process exit cleanup are handled centrally
// - Accessory/service structure changes are automatically pushed back to Homebridge
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

// Define our HomeKit device class
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
  static VERSION = '2026.09.09'; // Code version

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
  accessory = undefined; // HAP accessory for this device
  matterAccessory = undefined; // Homebridge Matter accessory for this device
  hap = undefined; // HomeKit Accessory Protocol (HAP) API stub
  matter = undefined; // Homebridge Matter API stub when enabled for this bridge
  log = undefined; // Logging function object
  backend = undefined; // Runtime backend type

  // Internal data only for this class
  #uuid = undefined; // UUID for this instance
  #platform = undefined; // Homebridge platform API
  #postSetupDetails = []; // Use for extra output details once a device has been setup
  #timers = new Map(); // Internal timers for this device

  constructor(accessory = undefined, api = undefined, deviceData = {}) {
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
      this.hap = api.hap;
      // Homebridge exposes the Matter API only for bridges configured to use it.
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

    // Listener ownership belongs to the runtime API, not an individual device.
    // A WeakSet prevents duplicates without retaining discarded Homebridge APIs.
    let shutdownSource =
      this.backend === HomeKitDevice.HOMEBRIDGE ? this.#platform : this.backend === HomeKitDevice.HAP_NODEJS ? process : undefined;
    if (typeof shutdownSource?.on === 'function' && HomeKitDevice.#shutdownRegistered.has(shutdownSource) === false) {
      HomeKitDevice.#shutdownRegistered.add(shutdownSource);

      let shutdown = async () => {
        if (HomeKitDevice.#shutdownFired === true) {
          return;
        }

        HomeKitDevice.#shutdownFired = true;
        await HomeKitDevice.shutdown();
      };

      if (this.backend === HomeKitDevice.HOMEBRIDGE) {
        shutdownSource.on('shutdown', shutdown);
      } else {
        ['SIGINT', 'SIGTERM'].forEach((signal) => shutdownSource.on(signal, shutdown));
      }
    }

    // Validate the data passed in to the constructor to ensure we have the minimum required data to create a HomeKit accessory
    if (this.#validDeviceData(deviceData, true) === false) {
      throw new TypeError('Invalid device data supplied to HomeKitDevice');
    }

    // Make a clone of current data and store in this object
    // Important that we don't have a 'linked' copy of the object data
    this.deviceData = structuredClone(deviceData);

    // This UUID is the persistent internal identity shared by the device's HAP
    // and Matter representations, so generation must succeed before registration.
    this.#uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, this.deviceData.serialNumber);

    // Register this device instance in the static device registry
    HomeKitDevice.#deviceRegistry.set(this.#uuid, this);

    // See if we were passed an existing accessory object or array of accessory objects.
    // Homebridge restores HAP and Matter accessories through separate callbacks, but
    // callers can combine those cached objects in the existing constructor argument.
    if (typeof accessory === 'object' && accessory !== null && this.backend === HomeKitDevice.HOMEBRIDGE) {
      let cachedAccessories = Array.isArray(accessory) === true ? accessory : [accessory];

      // HAP and Matter cache objects have no shared base type, so identify them
      // by the capabilities Homebridge exposes on each representation.
      this.accessory = cachedAccessories.find(
        (cachedAccessory) => cachedAccessory?.UUID === this.#uuid && typeof cachedAccessory?.getService === 'function',
      );
      if (this.matter !== undefined) {
        this.matterAccessory = cachedAccessories.find(
          (cachedAccessory) =>
            cachedAccessory?.UUID === this.#uuid &&
            typeof cachedAccessory?.getService !== 'function' &&
            cachedAccessory?.deviceType !== undefined,
        );
      }
    }
  }

  // Class functions
  async add(options = {}) {
    if (options === null || typeof options !== 'object' || options.constructor !== Object) {
      return;
    }

    if (
      (this.hap === undefined && this.matter === undefined) || // No protocol API initialised
      typeof HomeKitDevice.PLUGIN_NAME !== 'string' || // Plugin name must be defined
      HomeKitDevice.PLUGIN_NAME === '' ||
      typeof HomeKitDevice.PLATFORM_NAME !== 'string' || // Platform name must be defined
      HomeKitDevice.PLATFORM_NAME === '' ||
      // HAP-NodeJS only: accessory name must be valid
      (this.backend === HomeKitDevice.HAP_NODEJS &&
        (typeof options?.hapAccessoryName !== 'string' || options?.hapAccessoryName === '')) ||
      // HAP-NodeJS only: category must be valid
      (this.backend === HomeKitDevice.HAP_NODEJS && typeof this.hap.Categories[options?.hapCategory] === 'undefined') ||
      (options?.enableHistory !== undefined && typeof options?.enableHistory !== 'boolean') || // History flag must be boolean
      this.#validDeviceData(this.deviceData, true) === false // Device data failed validation (core + pairing if required)
    ) {
      return;
    }

    // HAP remains the Homebridge default for compatibility. Passing null
    // explicitly selects Matter-only operation.
    if (this.accessory === undefined && (this.backend === HomeKitDevice.HAP_NODEJS || options?.hapAccessoryName !== null)) {
      if (this.backend === HomeKitDevice.HAP_NODEJS) {
        this.accessory = new this.hap.Accessory(options?.hapAccessoryName, this.#uuid);
        this.accessory.username = this.deviceData.hkUsername;
        this.accessory.pincode = this.deviceData.hkPairingCode;
        this.accessory.category = options?.hapCategory;
      } else if (typeof this.#platform?.platformAccessory === 'function') {
        this.accessory = new this.#platform.platformAccessory(this.deviceData.description, this.#uuid, options?.hapCategory);
      }
    }

    // AccessoryInformation and EveHome are HAP-only concerns. Matter metadata
    // lives directly on the MatterAccessory descriptor and has no HAP service.
    if (this.accessory !== undefined) {
      let informationService = this.accessory.getService?.(this.hap.Service.AccessoryInformation);
      if (informationService === undefined) {
        this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
        if (typeof this.#platform?.unregisterPlatformAccessories === 'function') {
          try {
            this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
          } catch (error) {
            this?.log?.warn?.('Failed to unregister invalid HAP accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
          }
        }
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

    // Register a new Homebridge HAP accessory only after its required metadata exists.
    if (this.accessory !== undefined && this.backend === HomeKitDevice.HOMEBRIDGE && this.accessory?.UUID === this.#uuid) {
      if (typeof this.#platform?.registerPlatformAccessories === 'function') {
        try {
          this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
        } catch (error) {
          this.accessory = undefined;
          this?.log?.warn?.('Failed to register HAP accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
        }
      } else {
        this.accessory = undefined;
      }

      if (this.accessory === undefined) {
        this.historyService = undefined;
      }
    }

    this.postSetupDetail('Serial number "%s"', this.deviceData.serialNumber, LOG_LEVELS.DEBUG);
    this.postSetupDetail('Software version "%s"', this.deviceData.softwareVersion, LOG_LEVELS.DEBUG);

    // message() reports trapped handler failures so partial setup can be rolled back.
    if ((await this.message(HomeKitDevice.ADD)) === false) {
      if (this.accessory !== undefined && typeof this.#platform?.unregisterPlatformAccessories === 'function') {
        try {
          this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
        } catch (error) {
          this?.log?.warn?.('Failed to roll back HAP accessory "%s": %s', this.deviceData.description, String(error?.stack || error));
        }
      }
      this.accessory = undefined;
      this.historyService = undefined;
      this.matterAccessory = undefined;
      this.#postSetupDetails = [];
      this?.log?.error?.('Accessory setup failed for "%s"', this.deviceData.description);
      return;
    }

    // Homebridge Matter is independent of the HAP path above. A subclass defines
    // its descriptor through the existing onAdd() lifecycle. Register both new
    // and restored descriptors so command handlers are attached on every launch.
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
      this?.log?.error?.('No accessory representation was registered for "%s"', this.deviceData.description);
      this.#postSetupDetails = [];
      return false;
    }

    if (this.historyService?.EveHome !== undefined) {
      this.postSetupDetail('EveHome support as "%s"', this.historyService.EveHome.evetype);
    }

    // Trigger registered handlers (onUpdate + listeners) for initial device data updates
    await this.message(HomeKitDevice.UPDATE, this.deviceData, { force: true });

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.accessory !== undefined && this.backend === HomeKitDevice.HAP_NODEJS) {
      await this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });

      this?.log?.info?.('  += Advertising as "%s"', this.accessory.displayName);
      this?.log?.info?.('  += Pairing code is "%s"', this.accessory.pincode);
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

  async remove() {
    // Trigger registered handlers (onRemove + listeners)
    await this.message(HomeKitDevice.REMOVE);
  }

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

  async shutdown() {
    // Trigger registered handlers (onShutdown + listeners)
    await this.message(HomeKitDevice.SHUTDOWN);
  }

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

  async get(values, ...args) {
    // Trigger registered handlers (onGet + listeners)
    return this.message(HomeKitDevice.GET, values, ...args);
  }

  static async message(uuid, type, message = undefined, ...args) {
    if (typeof uuid !== 'string' || uuid === '' || typeof type !== 'string' || type === '') {
      return;
    }

    if (typeof message === 'function' || (typeof message === 'object' && message !== null && message?.constructor !== Object)) {
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

      if (handler !== undefined) {
        if (this.#listeners?.[uuid]?.[type]?.find?.((h) => h.handler === handler && h.context === context) === undefined) {
          this.#listeners[uuid][type].push({ handler, context });
        }
      }

      return;
    }

    // Handle message delivery
    return this.#deviceRegistry.get(uuid)?.message?.(type, message, ...args);
  }

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

      // Internal helper to call handlers with error trapping. Will also walk up the prototype chain
      const callLifecycleHook = async (labelOrFn, ...params) => {
        let results = [];
        let called = new Set(); // track calls using context + function identity

        const callMethodWithProtoChain = async (obj, method, contextLabel) => {
          let current = obj;
          let seen = new Set();

          while (current && typeof current === 'object' && seen.has(current) === false) {
            seen.add(current);

            let fn = current?.[method];
            if (typeof fn === 'function') {
              let key = fn + '@' + obj;
              if (called.has(key) === false) {
                called.add(key);
                try {
                  results.push(await fn.apply(obj, params));
                } catch (error) {
                  failed = true;
                  this?.log?.warn?.('Error in %s.%s(): %s', contextLabel, method, String(error?.stack || error));
                }
              }
            }

            current = Object.getPrototypeOf(current);
          }
        };

        if (typeof labelOrFn === 'string') {
          await callMethodWithProtoChain(this, labelOrFn, this?.constructor?.name ?? 'this');
        } else if (typeof labelOrFn === 'function') {
          let key = labelOrFn + '@' + this;
          if (called.has(key) === false) {
            called.add(key);
            try {
              results.push(await labelOrFn(...params));
            } catch (error) {
              failed = true;
              this?.log?.warn?.('Error in inline function handler: %s', String(error?.stack || error));
            }
          }
        } else if (Array.isArray(labelOrFn) === true) {
          let [label, list] = labelOrFn;

          for (let item of list || []) {
            let fn = item?.handler;
            let context = item?.context ?? this;
            let key = fn + '@' + context;

            if (typeof fn === 'function') {
              if (called.has(key) === false) {
                called.add(key);
                try {
                  results.push(await fn.call(context, ...params));
                } catch (error) {
                  failed = true;
                  this?.log?.warn?.('Error in registered %s(): %s', label, String(error?.stack || error));
                }
              }
            } else if (typeof fn === 'string' && context) {
              await callMethodWithProtoChain(context, fn, context?.constructor?.name ?? 'handler');
            }
          }
        }

        return results.length === 1 ? results[0] : results;
      };

      // Snapshot both structure and shared metadata because Homebridge persists
      // either kind of change through updatePlatformAccessories().
      const snapshotAccessoryStructure = (accessory) => {
        let information = accessory?.getService?.(this.hap.Service.AccessoryInformation);
        return {
          displayName: accessory?.displayName,
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

      // First up, we want to take a "snapshot" of services and characteristics on this accessory
      // This will be used after all message calling to see if any changes have occurred on the accessory
      // And if so, and running under Homebridge, we'll notify it of the changes
      let originalServices =
        this.backend === HomeKitDevice.HOMEBRIDGE &&
        this.accessory !== undefined &&
        typeof this.#platform?.updatePlatformAccessories === 'function'
          ? snapshotAccessoryStructure(this.accessory)
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

          if (this.accessory !== undefined && typeof this.#platform?.unregisterPlatformAccessories === 'function') {
            try {
              this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
            } catch (error) {
              this?.log?.warn?.(
                'Failed to unregister Homebridge accessory "%s": %s',
                this.deviceData.description,
                String(error?.stack || error),
              );
            }
          }

          if (
            this.matterAccessory !== undefined &&
            typeof this.matter?.unregisterPlatformAccessories === 'function'
          ) {
            try {
              await this.matter.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [
                this.matterAccessory,
              ]);
            } catch (error) {
              this?.log?.warn?.(
                'Failed to unregister Matter accessory "%s": %s',
                this.deviceData.description,
                String(error?.stack || error),
              );
            }
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

          await this.#updateAccessoryInformation(merged);

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
          if (Number.isFinite(Number(entry?.time)) === false) {
            entry.time = Math.floor(Date.now() / 1000);
          }

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
        typeof this.#platform?.updatePlatformAccessories === 'function'
      ) {
        // Let's see what's changed (if anything) on the accessory
        let newServices = snapshotAccessoryStructure(this.accessory);
        if (JSON.stringify(originalServices) !== JSON.stringify(newServices)) {
          // We have changes detected for our accessory (services and/or characteristics)
          // Notify Homebridge if that's our "backend" system
          this.#platform.updatePlatformAccessories([this.accessory]);
        }
      }

      // No handler at all — not even onMessage()
      if (handled === false && (Array.isArray(handler) === false || handler.length === 0) && typeof this?.[methodName] !== 'function') {
        this?.log?.debug?.('Unhandled message type "%s" for device "%s"', type, this.deviceData.description);
      }

      if (failed === true) {
        return false;
      }

      if (typeof result.call === 'object' || typeof result.handler === 'object') {
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

      Promise.resolve(
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

  hasTimer(timerHandle) {
    // Check if a timer with this handle is currently active/registered
    if (typeof timerHandle !== 'string' || timerHandle === '') {
      return false;
    }

    return this.#timers.has(timerHandle) === true;
  }

  addService(serviceType, name = '', subType = undefined, eveOptions = undefined) {
    let service = undefined;

    if (
      serviceType !== undefined &&
      typeof this?.accessory?.getService === 'function' &&
      typeof this?.accessory?.getServiceById === 'function' &&
      typeof this?.accessory?.addService === 'function'
    ) {
      if (subType !== undefined) {
        service = this.accessory.getServiceById(serviceType, subType);
      } else {
        service = this.accessory.getService(serviceType);
      }

      if (service === undefined) {
        service = this.accessory.addService(serviceType, name, subType);
      }

      // Setup for EveHome history if enabled. The actual linkage will be done in .add() after returning from .onAdd()
      if (service !== undefined && eveOptions !== null && typeof eveOptions === 'object' && eveOptions.constructor === Object) {
        service[HomeKitDevice?.EVEHOME?.EVE_OPTIONS] = eveOptions;
      }
    }

    return service;
  }

  removeService(serviceOrType, subType = undefined) {
    let service = undefined;
    let isServiceInstance = typeof this?.hap?.Service === 'function' && serviceOrType instanceof this.hap.Service;

    // Accessory must support service removal.
    if (typeof this?.accessory?.removeService !== 'function') {
      return false;
    }

    // Accept an existing service instance directly.
    if (isServiceInstance === true) {
      service = serviceOrType;
    } else if (
      serviceOrType !== undefined &&
      typeof this?.accessory?.getService === 'function' &&
      typeof this?.accessory?.getServiceById === 'function'
    ) {
      // Or resolve the service by type, optionally with a subtype.
      if (subType !== undefined) {
        service = this.accessory.getServiceById(serviceOrType, subType);
      } else {
        service = this.accessory.getService(serviceOrType);
      }
    }

    // Nothing to remove.
    if (service === undefined) {
      return false;
    }

    this.accessory.removeService(service);
    return true;
  }

  addCharacteristic(service, characteristicType, { props, onSet, onGet, initialValue } = {}) {
    let characteristic = undefined;

    if (
      characteristicType !== undefined &&
      typeof service?.getCharacteristic === 'function' &&
      typeof service?.testCharacteristic === 'function' &&
      typeof service?.addCharacteristic === 'function' &&
      typeof service?.addOptionalCharacteristic === 'function'
    ) {
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

      characteristic = service.getCharacteristic(characteristicType);

      // Apply optional config
      if (typeof onSet === 'function') {
        characteristic.onSet(onSet);
      }
      if (typeof onGet === 'function') {
        characteristic.onGet(onGet);
      }
      if (props !== null && typeof props === 'object' && props.constructor === Object && typeof characteristic.setProps === 'function') {
        characteristic.setProps(props);
      }

      // Set initial value if provided
      if (typeof initialValue !== 'undefined' && typeof service?.updateCharacteristic === 'function') {
        service.updateCharacteristic(characteristicType, initialValue);
      }
    }

    return characteristic;
  }

  removeCharacteristic(service, characteristicOrType) {
    let characteristic = undefined;
    let isCharacteristicInstance =
      typeof this?.hap?.Characteristic === 'function' && characteristicOrType instanceof this.hap.Characteristic;

    if (typeof service?.removeCharacteristic !== 'function' || Array.isArray(service?.characteristics) !== true) {
      return false;
    }

    // Accept an existing characteristic instance directly.
    if (isCharacteristicInstance === true) {
      characteristic = characteristicOrType;
    } else if (characteristicOrType !== undefined) {
      // Or resolve by type without calling getCharacteristic(), which can add optional characteristics.
      characteristic = service.characteristics.find((entry) => entry?.UUID === characteristicOrType?.UUID);
    }

    // Nothing to remove.
    if (characteristic === undefined) {
      return false;
    }

    service.removeCharacteristic(characteristic);
    return true;
  }

  postSetupDetail(message, ...args) {
    if (typeof message !== 'string' || message === '') {
      return;
    }

    let levelKey = 'INFO';
    let lastArg = args.at(-1);

    if (typeof lastArg === 'string' && Object.hasOwn(LOG_LEVELS, lastArg.toUpperCase()) === true) {
      levelKey = lastArg.toUpperCase();
      args = args.slice(0, -1);
    }

    this.#postSetupDetails.push({
      level: LOG_LEVELS[levelKey], // 'info', 'debug', etc.
      message,
      args: args.length > 0 ? args : undefined,
    });
  }

  static generateUUID(PLUGIN_NAME, api, serialNumber) {
    if (typeof PLUGIN_NAME !== 'string' || PLUGIN_NAME === '' || typeof serialNumber !== 'string' || serialNumber === '') {
      throw new TypeError('Unable to generate accessory UUID');
    }

    // Prefer HAP so enabling Matter cannot change an existing identity. Matter's
    // UUID API is its alias; direct HAP-NodeJS exposes the API at the root.
    let uuid = (api?.hap?.uuid ?? api?.matter?.uuid ?? api?.uuid)?.generate?.(
      PLUGIN_NAME + '_' + serialNumber.toUpperCase(),
    );
    if (typeof uuid !== 'string' || uuid === '') {
      throw new TypeError('Unable to generate accessory UUID');
    }
    return uuid;
  }

  static makeValidHKName(name) {
    // Strip invalid characters to meet HomeKit naming requirements.
    // Ensure names start and end with a Unicode letter or number.
    // Allow letters, numbers, space-like characters, apostrophes,
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

  get uuid() {
    return this.#uuid;
  }

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

  async #updateAccessoryInformation(deviceData) {
    if (
      typeof deviceData?.serialNumber === 'string' &&
      deviceData.serialNumber !== '' &&
      deviceData.serialNumber.toUpperCase() !== this.deviceData.serialNumber?.toUpperCase()
    ) {
      this?.log?.warn?.('Serial number on "%s" has changed', deviceData.description);
      this?.log?.warn?.('This may cause the device to become unresponsive in HomeKit or Matter');
    }

    // AccessoryInformation exists only for a HAP representation.
    if (this.accessory !== undefined) {
      let informationService = this.accessory?.getService?.(this.hap.Service.AccessoryInformation);
      if (informationService === undefined) {
        this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
      } else {
        // Update details associated with the accessory: Name, Manufacturer, Model, Serial # and firmware version
        // Check against actual characteristic values to ensure sync regardless of how state got out of sync

        // Description/Name
        if (typeof deviceData?.description === 'string' && deviceData.description !== '') {
          informationService.updateCharacteristic(this.hap.Characteristic.Name, deviceData.description);
          if (typeof this.accessory === 'object' && this.accessory.displayName !== deviceData.description) {
            this.accessory.displayName = deviceData.description;
          }
        }

        // Manufacturer
        if (typeof deviceData?.manufacturer === 'string' && deviceData.manufacturer !== '') {
          informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, deviceData.manufacturer);
        }

        // Model
        if (typeof deviceData?.model === 'string' && deviceData.model !== '') {
          informationService.updateCharacteristic(this.hap.Characteristic.Model, deviceData.model);
        }

        // Firmware Revision
        if (typeof deviceData?.softwareVersion === 'string' && deviceData.softwareVersion !== '') {
          informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceData.softwareVersion);

          // Remove SoftwareRevision if it exists
          if (informationService.testCharacteristic(this.hap.Characteristic.SoftwareRevision) === true) {
            this.removeCharacteristic(informationService, this.hap.Characteristic.SoftwareRevision);
          }
        }

        // SerialNumber
        if (typeof deviceData?.serialNumber === 'string' && deviceData.serialNumber !== '') {
          let currentSerial = informationService.getCharacteristic(this.hap.Characteristic.SerialNumber)?.value;
          if (currentSerial !== deviceData.serialNumber) {
            informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, deviceData.serialNumber);
          }
        }
      }
    }

    // Matter metadata is stored directly on the MatterAccessory descriptor.
    // Update its cache once after applying all changed common information.
    if (typeof this.matterAccessory === 'object' && this.matterAccessory !== null) {
      let metadata = {
        displayName: deviceData.description,
        manufacturer: deviceData.manufacturer,
        model: deviceData.model,
        serialNumber: deviceData.serialNumber,
        firmwareRevision: deviceData.softwareVersion,
      };
      let previous = new Map();

      Object.entries(metadata).forEach(([key, value]) => {
        if (typeof value === 'string' && value !== '' && this.matterAccessory[key] !== value) {
          previous.set(key, {
            exists: Object.hasOwn(this.matterAccessory, key),
            value: this.matterAccessory[key],
          });
          this.matterAccessory[key] = value;
        }
      });

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
            'Failed to update Matter accessory information for "%s": %s',
            deviceData.description,
            String(error?.stack || error),
          );
        }
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

  #validDeviceData(deviceData = {}, strict = false) {
    if (
      deviceData === null || // Must not be null
      typeof deviceData !== 'object' || // Must be an object
      deviceData.constructor !== Object // Must be a plain JSON object
    ) {
      return false;
    }

    let keys = ['serialNumber', 'softwareVersion', 'description', 'model', 'manufacturer'];
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

    // Pairing validation (HAP-NodeJS only — no Homebridge platform present)
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

  #clearTimers() {
    // Clear all internal timers for this device
    // Snapshot keys first to avoid mutating the Map while iterating
    for (let timerHandle of [...this.#timers.keys()]) {
      this.removeTimer(timerHandle);
    }
  }
}
