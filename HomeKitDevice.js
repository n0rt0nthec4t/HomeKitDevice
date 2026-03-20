// HomeKitDevice class
//
// Base class for all HomeKit accessories using Homebridge or HAP-NodeJS.
//
// Provides internal device tracking, metadata validation, lifecycle management,
// centralised message dispatch, and optional EveHome-compatible history logging.
//
// The `deviceData` object must include:
//   serialNumber, softwareVersion, description, manufacturer, model
//
// For enabling EveHome history support, include in the `deviceData`:
//   eveHistory
//
// For HAP-NodeJS standalone mode, also required:
//   hkUsername, hkPairingCode
//
// Platform bootstrap sets these base-class statics once for the plugin:
//   HomeKitDevice.PLUGIN_NAME           // Plugin identifier used for UUID generation and registration
//   HomeKitDevice.PLATFORM_NAME         // Homebridge platform identifier
//   HomeKitDevice.EVEHOME               // Optional EveHome-compatible history module
//
// Subclasses are expected to define:
//   HomeKitDevice.TYPE                  // Device type string
//   HomeKitDevice.VERSION               // Device code version
//
// The following instance methods can be optionally implemented by subclasses:
//
// Lifecycle events
//   async onAdd(message, ...args)        // Called when HomeKitDevice.ADD is received
//   async onSet(message, ...args)        // Called when HomeKitDevice.SET is received
//   async onUpdate(deviceData, ...args)  // Called when HomeKitDevice.UPDATE is received
//   async onRemove(message, ...args)     // Called when HomeKitDevice.REMOVE is received
//   async onShutdown(message, ...args)   // Called when HomeKitDevice.SHUTDOWN is received
//
// Timer hook
//   async onTimer(message, ...args)      // Called when HomeKitDevice.TIMER is received
//
// Data / history hooks
//   async onGet(message, ...args)        // Called when HomeKitDevice.GET is received
//   async onHistory(target, entry)       // Called after a history entry is logged
//
// Fallback handler
//   async onMessage(type, message)       // Called for unhandled or custom message types
//
// Messages should be sent via:
//   await device.message(type, message, ...args);
//
// All internal lifecycle events (`add`, `update`, `remove`, `shutdown`, `set`, `get`, `timer`, `history`)
// and external interactions must use the `message()` dispatch system for consistency.
//
// See README.md for usage examples and detailed documentation.
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'crypto';
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

  // HomeKit pin format and MAC address regex's
  static HK_PIN_3_2_3 = /^\d{3}-\d{2}-\d{3}$/;
  static HK_PIN_4_4 = /^\d{4}-\d{4}$/;
  static MAC_ADDR = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

  // Override this in the class which extends
  static PLUGIN_NAME = undefined; // Homebridge plugin name
  static PLATFORM_NAME = undefined; // Homebridge platform name
  static EVEHOME = undefined; // HomeKit History object
  static TYPE = 'base'; // String naming type of device
  static VERSION = '2026.03.15'; // Code version

  // Backend types
  static HOMEBRIDGE = 'homebridge';
  static HAP_NODEJS = 'hap-nodejs';

  // Global internal device and listener registry
  static #listeners = {};
  static #deviceRegistry = new Map();

  deviceData = {}; // The devices data we store
  historyService = undefined; // HomeKit history service
  accessory = undefined; // HomeKit accessory service for this device
  hap = undefined; // HomeKit Accessory Protocol (HAP) API stub
  log = undefined; // Logging function object
  backend = undefined; // Backend library type

  // Internal data only for this class
  #uuid = undefined; // UUID for this instance
  #platform = undefined; // Homebridge platform API
  #postSetupDetails = []; // Use for extra output details once a device has been setup
  #timers = new Map(); // Internal timers for this device

  constructor(accessory = undefined, api = undefined, log = undefined, deviceData = {}) {
    super(); // Setup event emitter for our class ONLY

    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.values(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    // Determine runtime environment (Homebridge vs HAP-NodeJS)
    if (typeof api?.hap === 'object' && isNaN(api?.version) === false && typeof api?.HAPLibraryVersion === 'undefined') {
      this.hap = api.hap;
      this.#platform = api;
      this.backend = HomeKitDevice.HOMEBRIDGE;
      this.postSetupDetail('Homebridge backend', LOG_LEVELS.DEBUG);

      // Register platform shutdown listener once (only for Homebridge backend)
      // Track in #listeners using special namespace key to avoid conflicts with UUID-keyed listeners
      if (HomeKitDevice.#listeners['__HOMEBRIDGE_SHUTDOWN__'] === undefined) {
        HomeKitDevice.#listeners['__HOMEBRIDGE_SHUTDOWN__'] = true;

        this.#platform.on('shutdown', async () => {
          // Notify all of our registered devices of Homebridge shutdown
          // This allowes them to do any necessary cleanup (like stopping advertising, clearing timers, etc) before the process exits
          await HomeKitDevice.#shutdownHandler();
        });
      }
    }

    if (typeof api?.hap === 'undefined' && isNaN(api?.version) === true && typeof api?.HAPLibraryVersion === 'function') {
      this.hap = api;
      this.backend = HomeKitDevice.HAP_NODEJS;
      this.postSetupDetail('HAP-NodeJS library', LOG_LEVELS.DEBUG);

      // Register process exit listener once (only for HAP-NodeJS backend)
      // Track in #listeners using special namespace key to avoid conflicts with UUID-keyed listeners
      if (HomeKitDevice.#listeners['__PROCESS_EXIT__'] === undefined) {
        HomeKitDevice.#listeners['__PROCESS_EXIT__'] = true;

        process.once('SIGTERM', async () => {
          await HomeKitDevice.#shutdownHandler();
        });
        process.once('SIGINT', async () => {
          await HomeKitDevice.#shutdownHandler();
        });
      }
    }

    // Generate UUID for this device instance
    // Will either be a random generated one or HAP generated one
    // HAP is based upon defined plugin name and devices serial number
    this.#uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, deviceData.serialNumber);

    // Register this device instance in the static device registry
    HomeKitDevice.#deviceRegistry.set(this.#uuid, this);

    // See if we were passed in an existing accessory object or array of accessory objects
    // Mainly used to restore a Homebridge cached accessory
    if (typeof accessory === 'object' && this.backend === HomeKitDevice.HOMEBRIDGE) {
      if (Array.isArray(accessory) === true) {
        this.accessory = accessory.find((accessory) => this?.uuid !== undefined && accessory?.UUID === this.#uuid);
      }
      if (Array.isArray(accessory) === false && accessory?.UUID === this.#uuid) {
        this.accessory = accessory;
      }
    }

    // Make a clone of current data and store in this object
    // Important that we done have a 'linked' copy of the object data
    this.deviceData = structuredClone(deviceData);
  }

  // Class functions
  async add(hapAccessoryName, hapCategory, enableHistory = false) {
    if (
      this.hap === undefined ||
      typeof HomeKitDevice.PLUGIN_NAME !== 'string' ||
      HomeKitDevice.PLUGIN_NAME === '' ||
      typeof HomeKitDevice.PLATFORM_NAME !== 'string' ||
      HomeKitDevice.PLATFORM_NAME === '' ||
      typeof hapAccessoryName !== 'string' ||
      hapAccessoryName === '' ||
      typeof this.hap.Categories[hapCategory] === 'undefined' ||
      typeof enableHistory !== 'boolean' ||
      typeof this.deviceData !== 'object' ||
      typeof this.deviceData?.serialNumber !== 'string' ||
      this.deviceData.serialNumber === '' ||
      typeof this.deviceData?.softwareVersion !== 'string' ||
      this.deviceData.softwareVersion === '' ||
      typeof this.deviceData?.description !== 'string' ||
      this.deviceData.description === '' ||
      typeof this.deviceData?.model !== 'string' ||
      this.deviceData.model === '' ||
      typeof this.deviceData?.manufacturer !== 'string' ||
      this.deviceData.manufacturer === '' ||
      (this.#platform === undefined &&
        (typeof this.deviceData?.hkPairingCode !== 'string' ||
          (HomeKitDevice.HK_PIN_3_2_3.test(this.deviceData.hkPairingCode) === false &&
            HomeKitDevice.HK_PIN_4_4.test(this.deviceData.hkPairingCode) === false) ||
          typeof this.deviceData?.hkUsername !== 'string' ||
          HomeKitDevice.MAC_ADDR.test(this.deviceData.hkUsername) === false))
    ) {
      return;
    }

    // If we do not have an existing accessory object, create a new one
    if (
      this.accessory === undefined &&
      typeof this.#platform?.platformAccessory === 'function' &&
      typeof this.#platform?.registerPlatformAccessories === 'function' &&
      this.backend === HomeKitDevice.HOMEBRIDGE
    ) {
      // Create Homebridge platform accessory
      this.accessory = new this.#platform.platformAccessory(this.deviceData.description, this.#uuid);
      try {
        this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }

    if (this.accessory === undefined && this.backend === HomeKitDevice.HAP_NODEJS) {
      // Create HAP-NodeJS libray accessory
      this.accessory = new this.hap.Accessory(hapAccessoryName, this.#uuid);

      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = hapCategory;
    }

    // Setup accessory information
    let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
      return;
    }

    if (informationService !== undefined) {
      informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
      informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
      informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serialNumber);
      informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.softwareVersion);
      informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);
    }

    // Setup our history service if module has been defined and requested to be active for this device
    if (typeof HomeKitDevice?.EVEHOME === 'function' && this.historyService === undefined && enableHistory === true) {
      this.historyService = new HomeKitDevice.EVEHOME(this.accessory, this.hap, this.log, {});
    }

    this.postSetupDetail('Serial number "%s"', this.deviceData.serialNumber, LOG_LEVELS.DEBUG);

    // Trigger registered handlers (onAdd + listeners)
    await this.message(HomeKitDevice.ADD);

    if (this.historyService?.EveHome !== undefined) {
      this.postSetupDetail('EveHome support as "%s"', this.historyService.EveHome.evetype);
    }

    this?.log?.success?.('Setup %s %s as "%s"', this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);
    this.#postSetupDetails.forEach((entry) => {
      if (typeof entry === 'string') {
        this?.log?.[LOG_LEVELS.INFO]?.('  += %s', entry);
      } else if (typeof entry?.message === 'string') {
        let level =
          Object.hasOwn(LOG_LEVELS, entry?.level?.toUpperCase?.()) &&
          typeof this?.log?.[LOG_LEVELS[entry.level.toUpperCase()]] === 'function'
            ? LOG_LEVELS[entry.level.toUpperCase()]
            : LOG_LEVELS.INFO;

        this?.log?.[level]?.('  += ' + entry.message, ...(Array.isArray(entry?.args) ? entry.args : []));
      }
    });

    // Trigger registered handlers (onUpdate + listeners) for initial device data updates
    await this.message(HomeKitDevice.UPDATE, this.deviceData, { force: true });

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.accessory !== undefined && this.backend === HomeKitDevice.HAP_NODEJS) {
      this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });

      this?.log?.info?.('  += Advertising as "%s"', this.accessory.displayName);
      this?.log?.info?.('  += Pairing code is "%s"', this.accessory.pincode);
    }
    this.#postSetupDetails = []; // Don't need these anymore
    return this.accessory; // Return our HomeKit accessory
  }

  async remove() {
    // Trigger registered handlers (onRemove + listeners)
    await this.message(HomeKitDevice.REMOVE);
  }

  async shutdown() {
    // Trigger registered handlers (onShutdown + listeners)
    await this.message(HomeKitDevice.SHUTDOWN);
  }

  async update(deviceData, ...args) {
    if (typeof deviceData !== 'object') {
      return;
    }

    // Trigger registered handlers (onUpdate + listeners)
    await this.message(HomeKitDevice.UPDATE, deviceData, ...args);
  }

  async history(target, entry, options = {}) {
    if (
      typeof this.historyService !== 'object' ||
      typeof this.historyService.addHistory !== 'function' ||
      typeof entry !== 'object' ||
      typeof target !== 'object' ||
      typeof target.UUID !== 'string'
    ) {
      return;
    }

    // Trigger registered handlers (onHistory + listeners)
    await this.message(HomeKitDevice.HISTORY, target, entry, options);
  }

  async set(values, ...args) {
    if (typeof values !== 'object' || values === null) {
      return;
    }

    // Trigger registered handlers (onSet + listeners)
    await this.message(HomeKitDevice.SET, values, ...args);
  }

  async get(values, ...args) {
    // Trigger registered handlers (onGet + listeners)
    return await this.message(HomeKitDevice.GET, values, ...args);
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

      if (typeof message === 'function' || typeof message === 'string') {
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
    return await this.#deviceRegistry.get(uuid)?.message?.(type, message, ...args);
  }

  async message(type, message, ...args) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    let result = { call: undefined, handler: undefined };
    let handled = false;
    let handler =
      Array.isArray(HomeKitDevice.#listeners?.[this.#uuid]?.[type]) === true
        ? HomeKitDevice.#listeners[this.#uuid][type]
        : HomeKitDevice.#listeners?.[this.#uuid]?.[type] !== undefined
          ? [HomeKitDevice.#listeners[this.#uuid][type]]
          : [];

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

    // Internal helper to snapshot accessory structure relating to services and characteristics
    const snapshotAccessoryStructure = (accessory) => {
      return Array.isArray(accessory?.services) === true
        ? accessory.services
            .map((service) => ({
              UUID: service.UUID,
              subtype: service.subtype ?? '',
              characteristics:
                Array.isArray(service.characteristics) === true
                  ? service.characteristics.map((characteristic) => characteristic.UUID).sort()
                  : [],
            }))
            .sort((a, b) => (a.UUID === b.UUID ? String(a.subtype).localeCompare(String(b.subtype)) : a.UUID.localeCompare(b.UUID)))
        : [];
    };

    // First up, we want to take a "snapshot" of services and characteristics on this accessory
    // This will be used after all message calling to see if any changes have occured on the accessory
    // And if so, and running under Homebridge, we'll notify it of the changes
    let originalServices = snapshotAccessoryStructure(this.accessory);

    // Handle built-in types with special behavior
    if (type === HomeKitDevice.ADD || type === HomeKitDevice.REMOVE || type === HomeKitDevice.SET) {
      // Call the dynamic on<Type> method (ie. onAdd, onRemove, onSet) and after
      // Any static handler registered via HomeKitDevice.message(uuid, type, handler)
      await callLifecycleHook(methodName, message, ...args);
      await callLifecycleHook(['handler for ' + type, handler], message, ...args);
      handled = true;

      // Special setup for ADD
      if (type === HomeKitDevice.ADD) {
        // After the accessory is initialised and onAdd has run, link any EveHome services that requested it
        if (this.deviceData?.eveHistory === true && typeof this.historyService?.linkToEveHome === 'function') {
          for (let service of this.accessory?.services || []) {
            let options = service?.[HomeKitDevice?.EVEHOME?.EVE_OPTIONS];
            if (options !== undefined) {
              delete service[HomeKitDevice?.EVEHOME?.EVE_OPTIONS];
              this.historyService.linkToEveHome(service, options);
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
            // eslint-disable-next-line no-unused-vars
          } catch (error) {
            // Empty
          }
        }

        if (this.accessory !== undefined && this.#platform === undefined) {
          this.accessory.unpublish();
        }

        this.deviceData = {};
        this.accessory = undefined;
        this.historyService = undefined;
        this.hap = undefined;
        this.log = undefined;
        this.#uuid = undefined;
        this.#platform = undefined;
      }

      // Update the internal data for the set values, as could take some time once we emit the event
      if (type === HomeKitDevice.SET) {
        if (typeof message === 'object' && message !== null) {
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
      if (typeof message === 'object' && message !== null) {
        let { merged, changed } = this.#mergeDeviceData(message);
        this.#updateAccessoryInformation(merged);

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
        typeof this.historyService === 'object' &&
        typeof this.historyService?.addHistory === 'function' &&
        typeof entry === 'object' &&
        typeof target === 'object' &&
        typeof target.UUID === 'string'
      ) {
        if (isNaN(entry?.time) === true) {
          entry.time = Math.floor(Date.now() / 1000);
        }

        if (options?.force !== true && typeof this.historyService?.lastHistory === 'function') {
          let last = this.historyService.lastHistory(target);
          if (typeof last === 'object') {
            let changed = Object.keys(entry).some((key) => {
              if (key === 'time') {
                return false;
              }
              let v = entry[key];
              let lv = last[key];
              return typeof v === 'object' ? JSON.stringify(v) !== JSON.stringify(lv) : v !== lv;
            });
            if (changed === false) {
              skipHistory = true;
            }
          }
        }

        if (skipHistory === false) {
          this.historyService.addHistory(target, entry, isNaN(options?.timegap) === false ? options.timegap : undefined);
        }
      }

      // Call the onHistory method and after any static handler registered via HomeKitDevice.message(uuid, type, handler)
      await callLifecycleHook('onHistory', target, entry, options);
      await callLifecycleHook(['handler for HISTORY', handler], target, entry, options);

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
    if (handled === false) {
      result.call = await callLifecycleHook('onMessage', type, message, ...args);
      handled = true;
    }

    // Lets see whats changed (if anything) on the accessory
    let newServices = snapshotAccessoryStructure(this.accessory);
    if (
      JSON.stringify(originalServices) !== JSON.stringify(newServices) &&
      this.accessory !== undefined &&
      typeof this.#platform?.updatePlatformAccessories === 'function'
    ) {
      // We have changes detected for our accessory (services and/or characteristics)
      // Notify Homebridge if thats our "backend" system
      this.#platform.updatePlatformAccessories([this.accessory]);
    }

    // No handler at all — not even onMessage()
    if (handled === false && (Array.isArray(handler) === false || handler.length === 0) && typeof this?.[methodName] !== 'function') {
      this?.log?.warn?.('Unhandled message type "%s" for device "%s"', type, this.deviceData.description);
    }

    if (typeof result.call === 'object' && typeof result.handler === 'object') {
      return Object.assign({}, result.call, result.handler);
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

    if (typeof options !== 'object' || options === null) {
      options = {};
    }

    let delay = isNaN(options?.delay) === false && Number(options.delay) > 0 ? Number(options.delay) : 0;
    let interval = isNaN(options?.interval) === false && Number(options.interval) > 0 ? Number(options.interval) : 0;
    let reset = options?.reset === true;
    let timerMessage = typeof options?.message === 'object' && options.message !== null ? options.message : {};

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
    };

    let fire = () => {
      // Direct callback takes precedence; message dispatch only if no callback provided
      // Callback errors are silently trapped to prevent timer chain failures
      if (typeof entry.callback === 'function') {
        try {
          entry.callback(timerHandle, entry.message);
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          // Empty
        }
        return;
      }

      // Otherwise, dispatch via message system (do not await to prevent blocking intervals if handler takes time)
      this.message(HomeKitDevice.TIMER, {
        timer: timerHandle,
        ...entry.message,
      }).catch(() => {
        // Empty
      });
    };

    // delay only => fire once
    if (delay > 0 && interval === 0) {
      entry.timeout = setTimeout(() => {
        fire();
        this.removeTimer(timerHandle);
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
      fire();

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

    try {
      clearTimeout(entry?.timeout);
      clearInterval(entry?.intervalHandle);
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Empty
    }

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

  addHKService(hkServiceType, name = '', subType = undefined, eveOptions = undefined) {
    let service = undefined;

    if (
      hkServiceType !== undefined &&
      typeof this?.accessory?.getService === 'function' &&
      typeof this?.accessory?.getServiceById === 'function' &&
      typeof this?.accessory?.addService === 'function'
    ) {
      if (subType !== undefined) {
        service = this.accessory.getServiceById(hkServiceType, subType);
      } else {
        service = this.accessory.getService(hkServiceType);
      }

      if (service === undefined) {
        service = this.accessory.addService(hkServiceType, name, subType);
      }

      // Setup for EveHome history if enabled. The actual linkage will be done in .add() after returning from .onAdd()
      if (
        service !== undefined &&
        typeof eveOptions === 'object' &&
        this.deviceData?.eveHistory === true &&
        typeof this.historyService?.linkToEveHome === 'function'
      ) {
        service[HomeKitDevice?.EVEHOME?.EVE_OPTIONS] = eveOptions;
      }
    }

    return service;
  }

  addHKCharacteristic(hkService, hkCharacteristicType, { props, onSet, onGet, initialValue } = {}) {
    let characteristic = undefined;

    if (
      hkCharacteristicType !== undefined &&
      typeof hkService?.getCharacteristic === 'function' &&
      typeof hkService?.testCharacteristic === 'function' &&
      typeof hkService?.addCharacteristic === 'function' &&
      typeof hkService?.addOptionalCharacteristic === 'function'
    ) {
      if (hkService.testCharacteristic(hkCharacteristicType) === false) {
        if (
          Array.isArray(hkService?.optionalCharacteristics) === true &&
          hkService.optionalCharacteristics.includes(hkCharacteristicType) === true
        ) {
          hkService.addOptionalCharacteristic(hkCharacteristicType);
        } else {
          hkService.addCharacteristic(hkCharacteristicType);
        }
      }

      characteristic = hkService.getCharacteristic(hkCharacteristicType);

      // Apply optional config
      if (typeof onSet === 'function') {
        characteristic.onSet(onSet);
      }
      if (typeof onGet === 'function') {
        characteristic.onGet(onGet);
      }
      if (typeof props === 'object' && typeof characteristic.setProps === 'function') {
        characteristic.setProps(props);
      }

      // Set initial value if provided
      if (typeof initialValue !== 'undefined' && typeof hkService?.updateCharacteristic === 'function') {
        hkService.updateCharacteristic(hkCharacteristicType, initialValue);
      }
    }

    return characteristic;
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
    let hap;
    let uuid = crypto.randomUUID();

    // Determine runtime environment (Homebridge vs HAP-NodeJS)
    if (typeof api?.hap === 'object' && isNaN(api?.version) === false && typeof api?.HAPLibraryVersion === 'undefined') {
      hap = api.hap;
    } else if (typeof api?.HAPLibraryVersion === 'function' && typeof api?.version === 'undefined' && typeof api?.hap === 'undefined') {
      hap = api;
    }

    if (
      typeof PLUGIN_NAME === 'string' &&
      PLUGIN_NAME !== '' &&
      typeof serialNumber === 'string' &&
      serialNumber !== '' &&
      typeof hap?.uuid?.generate === 'function'
    ) {
      uuid = hap.uuid.generate(PLUGIN_NAME + '_' + serialNumber.toUpperCase());
    }

    return uuid;
  }

  static makeValidHKName(name) {
    // Strip invalid characters to meet HomeKit naming requirements
    // Ensure only letters or numbers are at the beginning AND/OR end of string
    // Matches against uni-code characters
    return typeof name === 'string'
      ? name
          .replace(/[^\p{L}\p{N}\p{Z}\u2019.,-]/gu, '')
          .replace(/^[^\p{L}\p{N}]*/gu, '')
          .replace(/[^\p{L}\p{N}]+$/gu, '')
      : name;
  }

  get uuid() {
    return this.#uuid;
  }

  #mergeDeviceData(deviceDataUpdates = {}) {
    let merged = { ...deviceDataUpdates };

    // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
    // and merge with the updates to ensure we have a complete data object
    Object.entries(this.deviceData).forEach(([key, value]) => {
      if (typeof merged[key] === 'undefined') {
        // Updated data doesn't have this key, so add it to our internally stored data
        merged[key] = value;
      }
    });

    // Check updated device data with our internally stored data. Flag if changes between the two
    let changed = false;
    Object.keys(merged).forEach((key) => {
      if (JSON.stringify(merged[key]) !== JSON.stringify(this.deviceData[key])) {
        changed = true;
      }
    });

    return { merged, changed };
  }

  #updateAccessoryInformation(deviceData) {
    // Always update accessory information if we have changed data
    let informationService = this.accessory?.getService?.(this.hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      this?.log?.error?.('AccessoryInformation service not found on accessory for "%s"', this.deviceData.description);
      return;
    }

    // Update details associated with the accessory: Name, Manufacturer, Model, Serial # and firmware version
    // Check against actual characteristic values to ensure sync regardless of how state got out of sync

    // Description/Name
    if (typeof deviceData?.description === 'string' && deviceData.description !== '') {
      let currentName = informationService.getCharacteristic(this.hap.Characteristic.Name)?.value;
      if (currentName !== deviceData.description) {
        informationService.updateCharacteristic(this.hap.Characteristic.Name, deviceData.description);
      }
      if (this.accessory !== undefined && typeof this.accessory === 'object' && this.accessory.displayName !== deviceData.description) {
        this.accessory.displayName = deviceData.description;
      }
    }

    // Manufacturer
    if (typeof deviceData?.manufacturer === 'string' && deviceData.manufacturer !== '') {
      let currentManufacturer = informationService.getCharacteristic(this.hap.Characteristic.Manufacturer)?.value;
      if (currentManufacturer !== deviceData.manufacturer) {
        informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, deviceData.manufacturer);
      }
    }

    // Model
    if (typeof deviceData?.model === 'string' && deviceData.model !== '') {
      let currentModel = informationService.getCharacteristic(this.hap.Characteristic.Model)?.value;
      if (currentModel !== deviceData.model) {
        informationService.updateCharacteristic(this.hap.Characteristic.Model, deviceData.model);
      }
    }

    // SoftwareRevision
    if (typeof deviceData?.softwareVersion === 'string' && deviceData.softwareVersion !== '') {
      let currentSoftware = informationService.getCharacteristic(this.hap.Characteristic.SoftwareRevision)?.value;
      if (currentSoftware !== deviceData.softwareVersion) {
        informationService.updateCharacteristic(this.hap.Characteristic.SoftwareRevision, deviceData.softwareVersion);
      }
    }

    // SerialNumber
    if (typeof deviceData?.serialNumber === 'string' && deviceData.serialNumber !== '') {
      let currentSerial = informationService.getCharacteristic(this.hap.Characteristic.SerialNumber)?.value;
      if (currentSerial !== deviceData.serialNumber) {
        // Log warning if serial actually changed from stored data
        if (deviceData.serialNumber.toUpperCase() !== this.deviceData.serialNumber?.toUpperCase()) {
          this?.log?.warn?.('Serial number on "%s" has changed', deviceData.description);
          this?.log?.warn?.('This may cause the device to become unresponsive in HomeKit');
        }
        informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, deviceData.serialNumber);
      }
    }

    if (typeof deviceData?.online === 'boolean' && deviceData.online !== this.deviceData.online) {
      // Output device online/offline status
      if (deviceData.online === false) {
        this?.log?.warn?.('Device "%s" is offline', deviceData.description);
      }

      if (deviceData.online === true) {
        this?.log?.success?.('Device "%s" is online', deviceData.description);
      }
    }
  }

  #clearTimers() {
    // Clear all internal timers for this device
    for (let timerHandle of this.#timers.keys()) {
      this.removeTimer(timerHandle);
    }
  }

  static async #shutdownHandler() {
    // Notify all of our registered devices of process exit
    for (let device of Array.from(HomeKitDevice.#deviceRegistry.values())) {
      try {
        await device.shutdown();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }
  }
}
