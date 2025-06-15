// HomeKitDevice class
//
// This is the base class for all HomeKit accessories we code for in Homebridge/HAP-NodeJS
//
// The deviceData structure should at a minimum contain the following elements:
//
// Homebridge Plugin:
//
// serialNumber
// softwareVersion
// description
// manufacturer
// model
//
// HAP-NodeJS Library Accessory:
//
// serialNumber
// softwareVersion
// description
// manufacturer
// model
// hkUsername
// hkPairingCode
//
// Following constants should be overridden in the module loading this class file
//
// HomeKitDevice.HOMEKITHISTORY
// HomeKitDevice.PLUGIN_NAME
// HomeKitDevice.PLATFORM_NAME
// HomeKitDevice.TYPE
// HomeKitDevice.VERSION
//
// The following functions should be overriden in your class which extends this
//
// HomeKitDevice.setupDevice()
// HomeKitDevice.removeDevice()
// HomeKitDevice.updateDevice(deviceData)
// HomeKitDevice.messageDevice(type, message)
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'crypto';
import EventEmitter from 'node:events';

// Define constants
const LOG_LEVELS = {
  info: 'info',
  success: 'success',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

// Define our HomeKit device class
export default class HomeKitDevice {
  static UPDATE = 'HomeKitDevice.update'; // Device update message
  static REMOVE = 'HomeKitDevice.remove'; // Device remove message
  static SET = 'HomeKitDevice.set'; // Device set property message
  static GET = 'HomeKitDevice.get'; // Device get property message

  static HK_PIN_3_2_3 = /^\d{3}-\d{2}-\d{3}$/;
  static HK_PIN_4_4 = /^\d{4}-\d{4}$/;
  static MAC_ADDR = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

  // Override this in the class which extends
  static PLUGIN_NAME = undefined; // Homebridge plugin name
  static PLATFORM_NAME = undefined; // Homebridge platform name
  static HISTORY = undefined; // HomeKit History object
  static TYPE = 'base'; // String naming type of device
  static VERSION = '2025.06.15'; // Code version

  deviceData = {}; // The devices data we store
  historyService = undefined; // HomeKit history service
  accessory = undefined; // HomeKit accessory service for this device
  hap = undefined; // HomeKit Accessory Protocol (HAP) API stub
  log = undefined; // Logging function object
  uuid = undefined; // UUID for this instance

  // Internal data only for this class
  #platform = undefined; // Homebridge platform api
  #eventEmitter = undefined; // Event emitter to use for comms
  #postSetupDetails = []; // Use for extra output details once a device has been setup

  constructor(accessory, api, log, eventEmitter, deviceData) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (Object.keys(LOG_LEVELS).every((fn) => typeof log?.[fn] === 'function')) {
      this.log = log;
    }

    // Workout if we're running under Homebridge or HAP-NodeJS library
    if (isNaN(api?.version) === false && typeof api?.hap === 'object' && api?.HAPLibraryVersion === undefined) {
      // We have the Homebridge version number and hap API object
      this.hap = api.hap;
      this.#platform = api;

      this.postSetupDetail('Homebridge backend', LOG_LEVELS.debug);
    }

    if (typeof api?.HAPLibraryVersion === 'function' && api?.version === undefined && api?.hap === undefined) {
      // As we're missing the Homebridge entry points but have the HAP library version
      this.hap = api;

      this.postSetupDetail('HAP-NodeJS library', LOG_LEVELS.debug);
    }

    // Generate UUID for this device instance
    // Will either be a random generated one or HAP generated one
    // HAP is based upon defined plugin name and devices serial number
    this.uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, api, deviceData.serialNumber);

    // See if we were passed in an existing accessory object or array of accessory objects
    // Mainly used to restore a Homebridge cached accessory
    if (typeof accessory === 'object' && this.#platform !== undefined) {
      if (Array.isArray(accessory) === true) {
        this.accessory = accessory.find((accessory) => this?.uuid !== undefined && accessory?.UUID === this.uuid);
      }
      if (Array.isArray(accessory) === false && accessory?.UUID === this.uuid) {
        this.accessory = accessory;
      }
    }

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    // If valid, setup an event listener for messages to this device using our generated uuid
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
      this.#eventEmitter.addListener(this.uuid, this.#message.bind(this));
    }

    // Make a clone of current data and store in this object
    // Important that we done have a 'linked' copy of the object data
    // eslint-disable-next-line no-undef
    this.deviceData = structuredClone(deviceData);
  }

  // Class functions
  async add(accessoryName, accessoryCategory, useHistoryService) {
    if (
      this.hap === undefined ||
      typeof HomeKitDevice.PLUGIN_NAME !== 'string' ||
      HomeKitDevice.PLUGIN_NAME === '' ||
      typeof HomeKitDevice.PLATFORM_NAME !== 'string' ||
      HomeKitDevice.PLATFORM_NAME === '' ||
      typeof accessoryName !== 'string' ||
      accessoryName === '' ||
      typeof this.hap.Categories[accessoryCategory] === 'undefined' ||
      typeof useHistoryService !== 'boolean' ||
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
          HomeKitDevice.MAC_ADDR.test(this.deviceData.hkUsername).test(this.deviceData.hkUsername) === false))
    ) {
      return;
    }

    // If we do not have an existing accessory object, create a new one
    if (this.accessory === undefined && this.#platform !== undefined) {
      // Create Homebridge platform accessory
      this.accessory = new this.#platform.platformAccessory(this.deviceData.description, this.uuid);
      this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory === undefined && this.#platform === undefined) {
      // Create HAP-NodeJS libray accessory
      this.accessory = new this.hap.Accessory(accessoryName, this.uuid);

      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = accessoryCategory;
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
    if (typeof HomeKitDevice?.HISTORY === 'function' && this.historyService === undefined && useHistoryService === true) {
      this.historyService = new HomeKitDevice.HISTORY(this.accessory, this.log, this.hap, {});
    }

    if (typeof this?.setupDevice === 'function') {
      try {
        this.postSetupDetail('Serial number "%s"', this.deviceData.serialNumber, LOG_LEVELS.debug);

        await this.setupDevice();

        if (this.historyService?.EveHome !== undefined) {
          this.postSetupDetail('EveHome support as "%s"', this.historyService.EveHome.evetype);
        }

        this?.log?.info?.('Setup %s %s as "%s"', this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);

        this.#postSetupDetails.forEach((entry) => {
          if (typeof entry === 'string') {
            this?.log?.[LOG_LEVELS.info]?.('  += %s', entry);
          } else if (typeof entry?.message === 'string') {
            let level =
              Object.hasOwn(LOG_LEVELS, entry?.level) && typeof this?.log?.[entry?.level] === 'function' ? entry.level : LOG_LEVELS.info;
            this?.log?.[level]?.('  += ' + entry.message, ...(Array.isArray(entry?.args) ? entry.args : []));
          }
        });
      } catch (error) {
        this?.log?.error('setupDevice call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    // Perform an initial update using current data
    this.update(this.deviceData, true);

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.#platform === undefined && this.accessory !== undefined) {
      this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });

      this?.log?.info('  += Advertising as "%s"', this.accessory.displayName);
      this?.log?.info('  += Pairing code is "%s"', this.accessory.pincode);
    }
    this.#postSetupDetails = []; // Dont' need these anymore
    return this.accessory; // Return our HomeKit accessory
  }

  remove() {
    this?.log?.warn?.('Device "%s" has been removed', this.deviceData.description);

    if (this.#eventEmitter !== undefined) {
      // Remove listener for 'messages'
      this.#eventEmitter.removeAllListeners(this.uuid);
    }

    if (typeof this?.removeDevice === 'function') {
      try {
        this.removeDevice();
      } catch (error) {
        this?.log?.error('removeDevice call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    if (this.accessory !== undefined && this.#platform !== undefined) {
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
    this.uuid = undefined;
    this.#platform = undefined;
    this.#eventEmitter = undefined;

    // Do we destroy this object??
    // this = null;
    // delete this;
  }

  update(deviceData, forceUpdate) {
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
          // Update serial number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);
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

      if (typeof this?.updateDevice === 'function') {
        try {
          this.updateDevice(deviceData); // Pass updated data on for accessory to process as it needs
        } catch (error) {
          this?.log?.error('updateDevice call for device "%s" failed. Error was', deviceData.description, error);
        }
      }

      // Finally, update our internally stored data with the new data
      // eslint-disable-next-line no-undef
      this.deviceData = structuredClone(deviceData);
    }
  }

  async set(values) {
    if (typeof values !== 'object' || this.#eventEmitter === undefined) {
      return;
    }

    // Send event with data to set
    this.#eventEmitter.emit(HomeKitDevice.SET, this.uuid, values);

    // Update the internal data for the set values, as could take sometime once we emit the event
    Object.entries(values).forEach(([key, value]) => {
      if (this.deviceData[key] !== undefined) {
        this.deviceData[key] = value;
      }
    });
  }

  async get(values) {
    if (typeof values !== 'object' || this.#eventEmitter === undefined) {
      return;
    }

    // Send event with data to get
    // Once get has completed, we'll get an event back with the requested data
    this.#eventEmitter.emit(HomeKitDevice.GET, this.uuid, values);

    // This should always return, but we probably should put in a timeout?
    let results = await EventEmitter.once(this.#eventEmitter, HomeKitDevice.GET + '->' + this.uuid);
    return results?.[0];
  }

  #message(type, message) {
    switch (type) {
      case HomeKitDevice.UPDATE: {
        // Got some device data, so process any updates
        this.update(message, false);
        break;
      }

      case HomeKitDevice.REMOVE: {
        // Got message for device removal
        this.remove();
        break;
      }

      default: {
        // This is not a message we know about, so pass onto accessory for it to perform any processing
        if (typeof this?.messageDevice === 'function') {
          try {
            this.messageDevice(type, message);
          } catch (error) {
            this?.log?.error('messageDevice call for device "%s" failed. Error was', this.deviceData.description, error);
          }
        }
        break;
      }
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

  addHKCharacteristic(hkService, hkCharacteristicType, { props, onSet, onGet } = {}) {
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
          Array.isArray(hkService?.optionalCharacteristics) &&
          hkService.optionalCharacteristics.includes(hkCharacteristicType) &&
          typeof hkService?.addOptionalCharacteristic === 'function'
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
    }
    return characteristic;
  }

  postSetupDetail(message, ...args) {
    if (typeof message !== 'string' || message === '') {
      return;
    }

    let level = 'info';
    let availableLevel = Object.keys(LOG_LEVELS).find((lvl) => typeof this.log?.[lvl] === 'function') || 'info';
    let lastArg = args.at(-1);

    if (typeof lastArg === 'string' && Object.hasOwn(LOG_LEVELS, lastArg)) {
      level = lastArg;
      args = args.slice(0, -1);
    } else {
      level = availableLevel;
    }

    this.#postSetupDetails.push({
      level,
      message,
      args: args.length > 0 ? args : undefined,
    });
  }

  static generateUUID(PLUGIN_NAME, api, serialNumber) {
    let hap = undefined;
    let uuid = crypto.randomUUID();

    // Workout if we're running under Homebridge or HAP-NodeJS library
    if (isNaN(api?.version) === false && typeof api?.hap === 'object' && api?.HAPLibraryVersion === undefined) {
      // We have the Homebridge version number and hap API object
      hap = api.hap;
    }

    if (typeof api?.HAPLibraryVersion === 'function' && api?.version === undefined && api?.hap === undefined) {
      // As we're missing the Homebridge entry points but have the HAP library version
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

  static makeHomeKitName(name) {
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
}
