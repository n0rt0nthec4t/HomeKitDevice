// HomeKitDevice class
//
// Base class for all HomeKit accessories using Homebridge or HAP-NodeJS.
//
// Provides internal device tracking, metadata validation, lifecycle management,
// HomeKit messaging, and optional EveHome-compatible history logging.
//
// The `deviceData` object must include:
//   serialNumber, softwareVersion, description, manufacturer, model
//
// For HAP-NodeJS standalone mode, also required:
//   hkUsername, hkPairingCode
//
// The following static constants should be defined in subclasses:
//   HomeKitDevice.PLUGIN_NAME       // Required (string)
//   HomeKitDevice.PLATFORM_NAME     // Required (string)
//   HomeKitDevice.TYPE              // Optional (device type string)
//   HomeKitDevice.VERSION           // Optional (device code version)
//   HomeKitDevice.HOMEKITHISTORY    // Optional (Eve-compatible history module)
//
// The following instance methods may be overridden by subclasses:
//   async onAdd()                   // Called once during setup
//   async onRemove()                // Called when device is removed
//   async onUpdate(deviceData)      // Called when device is updated
//   async onMessage(type, message)  // Called for unhandled 'SET'/'GET'/custom messages
//   async onHistory(type, entry)    // Called after a history entry is logged
//
// See README.md for usage examples and detailed documentation.
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'crypto';
import EventEmitter from 'node:events';

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
  static UPDATE = 'HomeKitDevice.update';
  static REMOVE = 'HomeKitDevice.remove';
  static SET = 'HomeKitDevice.set';
  static GET = 'HomeKitDevice.get';

  // HomeKit pin format and MAC address regex's
  static HK_PIN_3_2_3 = /^\d{3}-\d{2}-\d{3}$/;
  static HK_PIN_4_4 = /^\d{4}-\d{4}$/;
  static MAC_ADDR = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

  // Override this in the class which extends
  static PLUGIN_NAME = undefined; // Homebridge plugin name
  static PLATFORM_NAME = undefined; // Homebridge platform name
  static HISTORY = undefined; // HomeKit History object
  static TYPE = 'base'; // String naming type of device
  static VERSION = '2025.06.18'; // Code version

  // Backend types
  static HOMEBRIDGE = 'homebridge';
  static HAPNODEJS = 'hap-nodejs';

  // Internal device and listener registry
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
    }

    if (typeof api?.hap === 'undefined' && isNaN(api?.version) === true && typeof api?.HAPLibraryVersion === 'function') {
      this.hap = api;
      this.backend = HomeKitDevice.HAPNODEJS;
      this.postSetupDetail('HAP-NodeJS library', LOG_LEVELS.DEBUG);
    }

    // Generate UUID for this device instance
    // Will either be a random generated one or HAP generated one
    // HAP is based upon defined plugin name and devices serial number
    this.#uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, deviceData.serialNumber);
    this.on(this.#uuid, this.message.bind(this));
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
      (typeof this.deviceData?.description !== 'string' && this.deviceData.description === '') ||
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
      this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory === undefined && this.backend === HomeKitDevice.HAPNODEJS) {
      // Create HAP-NodeJS libray accessory
      this.accessory = new this.hap.Accessory(hapAccessoryName, this.#uuid);

      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = hapCategory;
    }

    // Setup accessory information
    let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (informationService !== undefined) {
      informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
      informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
      informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serialNumber);
      informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.softwareVersion);
      informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);
    }

    // Setup our history service if module has been defined and requested to be active for this device
    if (typeof HomeKitDevice?.HISTORY === 'function' && this.historyService === undefined && enableHistory === true) {
      this.historyService = new HomeKitDevice.HISTORY(this.accessory, this.hap, this.log, {});
    }

    if (typeof this?.onAdd === 'function') {
      try {
        this.postSetupDetail('Serial number "%s"', this.deviceData.serialNumber, LOG_LEVELS.DEBUG);

        await this.onAdd();

        if (this.historyService?.EveHome !== undefined) {
          this.postSetupDetail('EveHome support as "%s"', this.historyService.EveHome.evetype);
        }

        this?.log?.info?.('Setup %s %s as "%s"', this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);
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
      } catch (error) {
        this?.log?.error?.('onAdd call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    // Perform an initial update using current data
    await this.update(this.deviceData, true);

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.accessory !== undefined && this.backend === HomeKitDevice.HAPNODEJS) {
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
    this?.log?.warn?.('Device "%s" has been removed', this.deviceData.description);

    // Remove listener for 'messages' and cleanup from device/listener registry
    this?.removeAllListeners?.(this.#uuid);
    HomeKitDevice.#deviceRegistry.delete(this.#uuid);
    delete HomeKitDevice.#listeners[this.#uuid];

    if (typeof this?.onRemove === 'function') {
      try {
        await this.onRemove();
      } catch (error) {
        this?.log?.error?.('onRemove call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    if (this.accessory !== undefined && typeof this.#platform?.unregisterPlatformAccessories === 'function') {
      // Unregister the accessory from Homebridge platform
      this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory !== undefined && this.#platform === undefined) {
      // Unpublish the accessory from HAP-NodeJS library
      this.accessory.unpublish();
    }

    this.deviceData = {};
    this.accessory = undefined;
    this.historyService = undefined;
    this.hap = undefined;
    this.log = undefined;
    this.#uuid = undefined;
    this.#platform = undefined;

    // Do we destroy this object??
    // this = null;
    // delete this;
  }

  async update(deviceData, forceUpdate) {
    if (typeof deviceData !== 'object' || typeof forceUpdate !== 'boolean') {
      return;
    }

    // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
    // and merge with the updates to ensure we have a complete data object
    Object.entries(this.deviceData).forEach(([key, value]) => {
      if (typeof deviceData[key] === 'undefined') {
        // Updated data doesn't have this key, so add it to our internally stored data
        deviceData[key] = value;
      }
    });

    // Check updated device data with our internally stored data. Flag if changes between the two
    let changedData = false;
    Object.keys(deviceData).forEach((key) => {
      if (JSON.stringify(deviceData[key]) !== JSON.stringify(this.deviceData[key])) {
        changedData = true;
      }
    });

    // If we have any changed data OR we've been requested to force an update, do so here
    if ((changedData === true || forceUpdate === true) && this.accessory !== undefined) {
      let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
      if (informationService !== undefined) {
        // Update details associated with the accessory
        // ie: Name, Manufacturer, Model, Serial # and firmware version
        if (typeof deviceData?.description === 'string' && deviceData.description !== this.deviceData.description) {
          // Update devices description on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Name, deviceData.description);
        }

        if (
          typeof deviceData?.manufacturer === 'string' &&
          deviceData.manufacturer !== '' &&
          deviceData.manufacturer !== this.deviceData.manufacturer
        ) {
          // Update manufacturer number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, deviceData.manufacturer);
        }

        if (typeof deviceData?.model === 'string' && deviceData.model !== '' && deviceData.model !== this.deviceData.model) {
          // Update model on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Model, deviceData.model);
        }

        if (
          typeof deviceData?.softwareVersion === 'string' &&
          deviceData.softwareVersion !== '' &&
          deviceData.softwareVersion !== this.deviceData.softwareVersion
        ) {
          // Update software version on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceData.softwareVersion);
        }

        // Check for devices serial number changing. Really shouldn't occur, but handle case anyway
        if (
          typeof deviceData?.serialNumber === 'string' &&
          deviceData.serialNumber !== '' &&
          deviceData.serialNumber.toUpperCase() !== this.deviceData.serialNumber.toUpperCase()
        ) {
          this?.log?.warn?.('Serial number on "%s" has changed', deviceData.description);
          this?.log?.warn?.('This may cause the device to become unresponsive in HomeKit');

          // Update software version on the HomeKit accessory
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

      if (typeof this?.onUpdate === 'function') {
        try {
          await this.onUpdate(deviceData); // Pass updated data on for accessory to process as it needs
        } catch (error) {
          this?.log?.error?.('onUpdate call for device "%s" failed. Error was', deviceData.description, error);
        }
      }

      // Finally, update our internally stored data with the new data
      this.deviceData = structuredClone(deviceData);
    }
  }

  static async message(uuid, type, messageOrCallback) {
    if (typeof messageOrCallback === 'function') {
      // Register handler
      if (typeof this.#listeners?.[uuid] !== 'object') {
        this.#listeners[uuid] = {};
      }

      this.#listeners[uuid][type] = messageOrCallback;
      return;
    }

    // Route message to device instance
    let device = this.#deviceRegistry.get(uuid);
    if (device && typeof device.message === 'function') {
      let result = await device.message(type, messageOrCallback);

      if (type === HomeKitDevice.SET && typeof messageOrCallback === 'object') {
        for (let [key, value] of Object.entries(messageOrCallback)) {
          if (typeof device.deviceData?.[key] !== 'undefined') {
            device.deviceData[key] = value;
          }
        }
      }

      return result;
    }
  }

  async message(type, message) {
    let result;
    let handled = false;

    let handler = HomeKitDevice.#listeners?.[this.uuid]?.[type];
    if (typeof handler === 'function') {
      result = await handler(message);
      handled = true;
    }

    if (type === HomeKitDevice.UPDATE) {
      await this.update(message, false);
      handled = true;
    }

    if (type === HomeKitDevice.REMOVE) {
      await this.remove();
      handled = true;
    }

    if (handled === false && typeof this?.onMessage === 'function') {
      try {
        result = await this.onMessage(type, message);
      } catch (error) {
        this?.log?.error?.('onMessage call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    return result;
  }

  async addHistory(target, entry, options = {}) {
    if (
      typeof this.historyService !== 'object' ||
      typeof this.historyService.addHistory !== 'function' ||
      typeof entry !== 'object' ||
      typeof target !== 'object' ||
      typeof target.UUID !== 'string'
    ) {
      return;
    }

    if (isNaN(entry?.time) === true) {
      entry.time = Math.floor(Date.now() / 1000);
    }

    if (options.force !== true && typeof this.historyService.lastHistory === 'function') {
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
          return; // No changes, so skip
        }
      }
    }

    this.historyService.addHistory(target, entry, isNaN(options?.timegap) === false ? options.timegap : undefined);

    if (typeof this?.onHistory === 'function') {
      try {
        await this.onHistory(target, entry);
      } catch (error) {
        this?.log?.error?.('onHistory call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }
  }

  setupEveHomeLink(service, options = {}) {
    // Only proceed if eveHistory is enabled and link function exists
    if (
      this.deviceData?.eveHistory === true &&
      typeof this.historyService?.linkToEveHome === 'function' &&
      typeof service === 'object' &&
      typeof service.UUID === 'string' &&
      typeof this?.accessory?.getService === 'function' &&
      Array.isArray(this.accessory?.services) === true &&
      this.accessory.services.includes(service) === true // Validate service belongs to this accessory
    ) {
      // Perform EveHome linkage
      this.historyService.linkToEveHome(service, options);
    }
  }

  addHKService(hkServiceType, name = '', subType = undefined) {
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
        if (Array.isArray(hkService?.optionalCharacteristics) && hkService.optionalCharacteristics.includes(hkCharacteristicType)) {
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
      if (typeof initialValue !== 'undefined' && typeof characteristic.updateValue === 'function') {
        characteristic.updateValue(initialValue);
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

    if (typeof lastArg === 'string' && Object.hasOwn(LOG_LEVELS, lastArg.toUpperCase())) {
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
}
