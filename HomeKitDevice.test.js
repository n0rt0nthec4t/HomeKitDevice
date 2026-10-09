// Verify protocol lifecycle, persistence, message routing, and timer behaviour
// using isolated HAP and Matter mocks without starting protocol servers.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import HomeKitDevice from './HomeKitDevice.js';

class MockCharacteristic {}

MockCharacteristic.Manufacturer = { UUID: 'manufacturer' };
MockCharacteristic.Model = { UUID: 'model' };
MockCharacteristic.SerialNumber = { UUID: 'serial-number' };
MockCharacteristic.FirmwareRevision = { UUID: 'firmware-revision' };
MockCharacteristic.SoftwareRevision = { UUID: 'software-revision' };
MockCharacteristic.Name = { UUID: 'name' };

class MockService {}

MockService.AccessoryInformation = { UUID: 'accessory-information' };

class MockInformationService {
  UUID = MockService.AccessoryInformation.UUID;
  subtype = undefined;
  characteristics = [];

  updateCharacteristic(type, value) {
    let characteristic = this.characteristics.find((entry) => entry.UUID === type.UUID);
    if (characteristic === undefined) {
      characteristic = { UUID: type.UUID, value: undefined };
      this.characteristics.push(characteristic);
    }
    characteristic.value = value;
    return this;
  }

  getCharacteristic(type) {
    return this.characteristics.find((entry) => entry.UUID === type.UUID);
  }

  testCharacteristic(type) {
    return this.characteristics.some((entry) => entry.UUID === type.UUID);
  }

  removeCharacteristic(characteristic) {
    this.characteristics = this.characteristics.filter((entry) => entry !== characteristic);
  }
}

class MockAccessory {
  constructor(displayName, UUID, category) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.category = category;
    this.services = [new MockInformationService()];
    this.published = false;
    this.unpublished = false;
  }

  getService(type) {
    return this.services.find((service) => service.UUID === type.UUID);
  }

  getServiceById(type, subtype) {
    return this.services.find((service) => service.UUID === type.UUID && service.subtype === subtype);
  }

  addService(type, name, subtype) {
    let service = { UUID: type.UUID, displayName: name, subtype, characteristics: [] };
    this.services.push(service);
    return service;
  }

  removeService(service) {
    this.services = this.services.filter((entry) => entry !== service);
  }

  async publish() {
    this.published = true;
  }

  async unpublish() {
    this.unpublished = true;
  }
}

const hap = {
  Accessory: MockAccessory,
  Categories: { SWITCH: 1, 1: 'SWITCH' },
  Characteristic: MockCharacteristic,
  Service: MockService,
  uuid: {
    generate(value) {
      return 'uuid:' + value;
    },
  },
};

const deviceData = (serialNumber) => ({
  serialNumber,
  softwareVersion: '1.0.0',
  description: 'Device ' + serialNumber,
  manufacturer: 'Example',
  model: 'Switch',
});

HomeKitDevice.PLUGIN_NAME = 'homebridge-example';
HomeKitDevice.PLATFORM_NAME = 'ExamplePlatform';

test('generateUUID preserves one deterministic identity across supported runtimes', () => {
  let homebridgeUUID = HomeKitDevice.generateUUID('homebridge-example', { hap }, 'device-01');
  let matterUUID = HomeKitDevice.generateUUID('homebridge-example', { matter: { uuid: hap.uuid } }, 'DEVICE-01');
  let hapNodeJSUUID = HomeKitDevice.generateUUID('homebridge-example', hap, 'DEVICE-01');

  assert.equal(homebridgeUUID, 'uuid:homebridge-example_DEVICE-01');
  assert.equal(matterUUID, homebridgeUUID);
  assert.equal(hapNodeJSUUID, homebridgeUUID);
});

test('generateUUID prefers HAP so enabling Matter does not change identity', () => {
  let uuid = HomeKitDevice.generateUUID(
    'homebridge-example',
    { hap, matter: { uuid: { generate: () => 'different-matter-uuid' } } },
    'DEVICE-01',
  );

  assert.equal(uuid, 'uuid:homebridge-example_DEVICE-01');
});

test('generateUUID fails instead of creating a transient accessory identity', () => {
  assert.throws(() => HomeKitDevice.generateUUID('', { hap }, 'DEVICE-01'), TypeError);
  assert.throws(() => HomeKitDevice.generateUUID('homebridge-example', {}, 'DEVICE-01'), TypeError);
  assert.throws(() => HomeKitDevice.generateUUID('homebridge-example', { hap }, ''), TypeError);
  assert.throws(
    () => HomeKitDevice.generateUUID('homebridge-example', { uuid: { generate: () => undefined } }, 'DEVICE-01'),
    TypeError,
  );
});

test('Homebridge honours the explicit Matter enablement check', () => {
  let matterEnabledChecks = 0;
  let cachedMatterAccessory = {
    UUID: 'uuid:homebridge-example_MATTER-DISABLED',
    deviceType: { name: 'OnOffSwitch' },
  };
  let api = {
    version: 2.7,
    hap,
    matter: { deviceTypes: { OnOffSwitch: cachedMatterAccessory.deviceType } },
    isMatterEnabled() {
      matterEnabledChecks += 1;
      return false;
    },
    on() {},
  };

  let device = new HomeKitDevice(cachedMatterAccessory, api, deviceData('MATTER-DISABLED'));

  assert.equal(matterEnabledChecks, 1);
  assert.equal(device.matter, undefined);
  assert.equal(device.matterAccessory, undefined);

  delete api.isMatterEnabled;
  device = new HomeKitDevice(cachedMatterAccessory, api, deviceData('MATTER-DISABLED'));

  assert.equal(matterEnabledChecks, 1);
  assert.equal(device.matter, undefined);
  assert.equal(device.matterAccessory, undefined);

  api.isMatterEnabled = () => {
    matterEnabledChecks += 1;
    return true;
  };
  device = new HomeKitDevice(cachedMatterAccessory, api, deviceData('MATTER-DISABLED'));

  assert.equal(matterEnabledChecks, 2);
  assert.equal(device.matter, api.matter);
  assert.equal(device.matterAccessory, cachedMatterAccessory);
});

test('constructor restores declared fields from a subclass persistence namespace', () => {
  class PersistedDevice extends HomeKitDevice {
    static PERSISTENCE_NAMESPACE = 'PersistedDevice';
  }

  let cachedHapAccessory = new MockAccessory('Cached HAP accessory', 'uuid:homebridge-example_PERSISTED-DATA');
  cachedHapAccessory.context = {
    PersistedDevice: {
      hapSetting: { source: 'hap' },
      sharedSetting: 'cached-hap',
      ignoredSetting: 'ignored',
    },
  };
  let cachedMatterAccessory = {
    UUID: 'uuid:homebridge-example_PERSISTED-DATA',
    deviceType: { name: 'OnOffSwitch' },
    context: {
      PersistedDevice: {
        matterSetting: 'matter',
        sharedSetting: 'cached-matter',
      },
    },
  };
  let api = {
    version: 2.7,
    hap,
    matter: {},
    isMatterEnabled() {
      return true;
    },
    on() {},
  };
  let device = new PersistedDevice(
    [cachedHapAccessory, cachedMatterAccessory],
    api,
    { ...deviceData('PERSISTED-DATA'), sharedSetting: 'current' },
    ['hapSetting', 'matterSetting', 'sharedSetting'],
  );

  assert.deepEqual(device.deviceData.hapSetting, { source: 'hap' });
  assert.equal(device.deviceData.matterSetting, 'matter');
  assert.equal(device.deviceData.sharedSetting, 'current');
  assert.equal(device.deviceData.ignoredSetting, undefined);

  cachedHapAccessory.context.PersistedDevice.hapSetting.source = 'changed';
  assert.deepEqual(device.deviceData.hapSetting, { source: 'hap' });
});

test('constructor rejects invalid persisted device data field declarations', () => {
  let data = deviceData('INVALID-PERSISTED-DATA');

  assert.throws(() => new HomeKitDevice(undefined, hap, data, 'setting'), TypeError);
  assert.throws(() => new HomeKitDevice(undefined, hap, data, ['']), TypeError);
  assert.throws(() => new HomeKitDevice(undefined, hap, data, ['setting', 'setting']), TypeError);
});

test('Homebridge honours the explicit HAP enablement check and legacy default', async () => {
  let hapEnabledChecks = 0;
  let hapRegistrations = 0;
  let cachedHapAccessory = new MockAccessory('Cached HAP accessory', 'uuid:homebridge-example_HAP-DISABLED');
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    isHapEnabled() {
      hapEnabledChecks += 1;
      return false;
    },
    registerPlatformAccessories() {
      hapRegistrations += 1;
    },
    on() {},
  };

  let device = new HomeKitDevice(cachedHapAccessory, api, deviceData('HAP-DISABLED'));

  assert.equal(device.backend, HomeKitDevice.HOMEBRIDGE);
  assert.equal(hapEnabledChecks, 1);
  assert.equal(device.hap, undefined);
  assert.equal(device.accessory, undefined);
  assert.equal(await device.add({ hapAccessoryName: 'Switch' }), undefined);
  assert.equal(hapRegistrations, 0);

  delete api.isHapEnabled;
  device = new HomeKitDevice(cachedHapAccessory, api, deviceData('HAP-DISABLED'));

  assert.equal(hapEnabledChecks, 1);
  assert.equal(device.hap, api.hap);
  assert.equal(device.accessory, cachedHapAccessory);
  assert.equal(await device.add({ hapAccessoryName: 'Switch' }), true);
  assert.equal(device.accessory, cachedHapAccessory);
  assert.equal(hapRegistrations, 0);
});

test('add requires at least one protocol API', async () => {
  let matterRegistrations = 0;
  let onAddCalls = 0;
  let matter = {
    async registerPlatformAccessories() {
      matterRegistrations += 1;
    },
  };
  let api = {
    version: 2.7,
    hap,
    matter,
    isHapEnabled() {
      return false;
    },
    isMatterEnabled() {
      return true;
    },
    on() {},
  };

  class MatterOnlySwitch extends HomeKitDevice {
    async onAdd() {
      onAddCalls += 1;
      assert.equal(this.hap, undefined);
      assert.equal(this.accessory, undefined);
      assert.equal(this.matterAccessory.UUID, this.uuid);
      assert.equal(matterRegistrations, 0);
      this.matterAccessory.clusters = { onOff: { onOff: false } };
    }
  }

  let device = new MatterOnlySwitch(undefined, api, deviceData('MATTER-API'));

  assert.equal(await device.add({ hapAccessoryName: null, matterDeviceType: {} }), true);
  assert.equal(matterRegistrations, 1);
  assert.equal(onAddCalls, 1);

  device = new MatterOnlySwitch(undefined, api, deviceData('MATTER-NOT-REQUESTED'));
  assert.equal(await device.add({ hapAccessoryName: null }), undefined);
  assert.equal(onAddCalls, 1);

  api.isMatterEnabled = () => false;
  device = new HomeKitDevice(undefined, api, deviceData('NO-PROTOCOL-API'));

  assert.equal(await device.add({ hapAccessoryName: null }), undefined);
});

test('Matter device type is required only when Matter is the sole Homebridge representation', async () => {
  let registrations = 0;
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      registrations += 1;
    },
    on() {},
  };

  let device = new HomeKitDevice(undefined, api, deviceData('HAP-WITHOUT-MATTER'));
  assert.equal(await device.add({ hapAccessoryName: 'Switch', matterDeviceType: 'ignored' }), true);
  assert.equal(registrations, 1);

  api.matter = { registerPlatformAccessories() {} };
  api.isMatterEnabled = () => true;
  device = new HomeKitDevice(undefined, api, deviceData('HAP-WITH-MATTER'));
  assert.equal(await device.add({ hapAccessoryName: 'Switch', matterDeviceType: 'invalid' }), true);
  assert.equal(registrations, 2);

  api.isHapEnabled = () => false;
  device = new HomeKitDevice(undefined, api, deviceData('MATTER-ONLY-INVALID'));
  assert.equal(await device.add({ hapAccessoryName: null, matterDeviceType: 'invalid' }), undefined);
  assert.equal(registrations, 2);
});

test('addMatterCluster merges state and command handlers without duplicating the cluster', async () => {
  let registeredAccessory;
  let api = {
    version: 2.7,
    hap,
    matter: {
      clusterNames: { OnOff: 'onOff', LevelControl: 'levelControl' },
      deviceTypes: { DimmableLight: { name: 'DimmableLight' } },
      async registerPlatformAccessories(plugin, platform, accessories) {
        registeredAccessory = accessories[0];
      },
    },
    isHapEnabled() {
      return false;
    },
    isMatterEnabled() {
      return true;
    },
    on() {},
  };

  let on = () => true;
  let off = () => false;

  class MatterLight extends HomeKitDevice {
    async onAdd() {
      let onOffState = this.addMatterCluster(this.matter.clusterNames.OnOff, {
        initialState: { onOff: false },
        handlers: { on },
      });
      let mergedOnOffState = this.addMatterCluster(this.matter.clusterNames.OnOff, {
        initialState: { globalSceneControl: true },
        handlers: { off },
      });

      assert.deepEqual(onOffState, { onOff: false });
      assert.deepEqual(mergedOnOffState, { onOff: false, globalSceneControl: true });

      this.addMatterCluster(this.matter.clusterNames.LevelControl, {
        initialState: { currentLevel: 100, minLevel: 1 },
      });
    }
  }

  let device = new MatterLight(undefined, api, { ...deviceData('MATTER-HELPER'), on: true, level: 75 });
  assert.equal(
    await device.add({ hapAccessoryName: null, matterDeviceType: api.matter.deviceTypes.DimmableLight }),
    true,
  );

  assert.equal(registeredAccessory, device.matterAccessory);
  assert.deepEqual(device.matterAccessory.clusters, {
    onOff: { onOff: false, globalSceneControl: true },
    levelControl: { currentLevel: 100, minLevel: 1 },
  });
  assert.equal(device.matterAccessory.handlers.onOff.on, on);
  assert.equal(device.matterAccessory.handlers.onOff.off, off);
  assert.equal(device.matterAccessory.getState, undefined);
  assert.equal(device.addMatterCluster('', { initialState: { ignored: true } }), undefined);
  assert.equal(Object.hasOwn(device.matterAccessory.clusters, ''), false);
});

test('Homebridge exposes HAP and Matter through the existing lifecycle', async () => {
  let calls = {
    hapRegistered: [],
    hapUpdated: [],
    hapUnregistered: [],
    matterRegistered: [],
    matterUnregistered: [],
    matterInformationUpdated: [],
    matterUpdated: [],
  };
  let api = {
    version: 2.7,
    hap,
    matter: {
      clusterNames: { OnOff: 'onOff' },
      deviceTypes: { OnOffSwitch: { name: 'OnOffSwitch' } },
      async registerPlatformAccessories(plugin, platform, accessories) {
        calls.matterRegistered.push({ plugin, platform, accessories });
      },
      async unregisterPlatformAccessories(plugin, platform, accessories) {
        calls.matterUnregistered.push({ plugin, platform, accessories });
      },
      async updatePlatformAccessories(accessories) {
        calls.matterInformationUpdated.push(accessories);
      },
      async updateAccessoryState(uuid, cluster, attributes) {
        calls.matterUpdated.push({ uuid, cluster, attributes });
      },
    },
    isMatterEnabled() {
      return true;
    },
    platformAccessory: MockAccessory,
    registerPlatformAccessories(plugin, platform, accessories) {
      calls.hapRegistered.push({ plugin, platform, accessories });
      accessories[0]._associatedPlugin = plugin;
      accessories[0]._associatedPlatform = platform;
    },
    unregisterPlatformAccessories(plugin, platform, accessories) {
      calls.hapUnregistered.push({ plugin, platform, accessories });
    },
    updatePlatformAccessories(accessories) {
      calls.hapUpdated.push(accessories);
    },
    on() {},
  };

  class MatterSwitch extends HomeKitDevice {
    async onAdd() {
      assert.equal(calls.hapRegistered.length, 1);
      assert.equal(calls.matterRegistered.length, 0);
      assert.equal(this.matterAccessory.UUID, this.uuid);
      assert.equal(this.matterAccessory.deviceType, this.matter.deviceTypes.OnOffSwitch);
      Object.assign(this.matterAccessory, {
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: () => this.set({ on: true }),
            off: () => this.set({ on: false }),
          },
        },
      });
    }

    async onUpdate(data) {
      await this.matter.updateAccessoryState(this.uuid, this.matter.clusterNames.OnOff, { onOff: data.on === true });
    }
  }

  let device = new MatterSwitch(undefined, api, { ...deviceData('HB-MATTER'), on: false }, ['on']);
  let added = await device.add({
    hapAccessoryName: 'Switch',
    hapCategory: hap.Categories.SWITCH,
    matterDeviceType: api.matter.deviceTypes.OnOffSwitch,
  });

  assert.equal(device.backend, HomeKitDevice.HOMEBRIDGE);
  assert.equal(device.hap, hap);
  assert.equal(device.matter, api.matter);
  assert.equal(device.accessory.category, hap.Categories.SWITCH);
  assert.equal(added, true);
  assert.equal(calls.hapRegistered.length, 1);
  assert.equal(calls.hapUpdated.length, 0);
  assert.equal(calls.matterRegistered.length, 1);
  assert.equal(calls.matterInformationUpdated.length, 0);
  assert.equal(calls.matterRegistered[0].accessories[0], device.matterAccessory);
  assert.deepEqual(calls.hapRegistered[0].accessories[0].context.HomeKitDevice, { on: false });
  assert.deepEqual(calls.matterRegistered[0].accessories[0].context.HomeKitDevice, { on: false });
  assert.notEqual(
    calls.hapRegistered[0].accessories[0].context.HomeKitDevice,
    calls.matterRegistered[0].accessories[0].context.HomeKitDevice,
  );
  assert.deepEqual(calls.matterUpdated.at(-1).attributes, { onOff: false });

  await device.update({ on: true });

  assert.deepEqual(device.accessory.context.HomeKitDevice, { on: true });
  assert.deepEqual(device.matterAccessory.context.HomeKitDevice, { on: true });
  assert.notEqual(device.accessory.context.HomeKitDevice, device.matterAccessory.context.HomeKitDevice);
  assert.equal(calls.hapUpdated.length, 1);
  assert.equal(calls.matterInformationUpdated.length, 1);

  await device.update({ on: true });

  assert.equal(calls.hapUpdated.length, 1);
  assert.equal(calls.matterInformationUpdated.length, 1);

  await device.remove();

  assert.equal(calls.hapUnregistered.length, 1);
  assert.equal(calls.matterUnregistered.length, 1);
  assert.equal(device.accessory, undefined);
  assert.equal(device.matterAccessory, undefined);
});

test('Matter persisted context rolls back and retries after a cache update failure', async () => {
  let updateCalls = 0;
  let failUpdate = true;
  let api = {
    version: 2.7,
    hap,
    matter: {
      async registerPlatformAccessories() {},
      async updatePlatformAccessories() {
        updateCalls += 1;
        if (failUpdate === true) {
          throw new Error('Matter cache unavailable');
        }
      },
    },
    isHapEnabled() {
      return false;
    },
    isMatterEnabled() {
      return true;
    },
    on() {},
  };
  let device = new HomeKitDevice(undefined, api, { ...deviceData('MATTER-CONTEXT-RETRY'), on: false }, ['on']);

  assert.equal(await device.add({ hapAccessoryName: null, matterDeviceType: {} }), true);

  await device.update({ on: true });

  assert.deepEqual(device.matterAccessory.context.HomeKitDevice, { on: false });
  assert.equal(updateCalls, 1);

  failUpdate = false;
  await device.update({ on: true });

  assert.deepEqual(device.matterAccessory.context.HomeKitDevice, { on: true });
  assert.equal(updateCalls, 2);

  await device.remove();
});

test('Matter teardown still runs when HAP teardown fails', async () => {
  let calls = [];
  let cachedHapAccessory = new MockAccessory('Cached HAP accessory', 'uuid:homebridge-example_TEARDOWN');
  cachedHapAccessory._associatedPlatform = HomeKitDevice.PLATFORM_NAME;
  let cachedMatterAccessory = {
    UUID: 'uuid:homebridge-example_TEARDOWN',
    deviceType: { name: 'OnOffSwitch' },
  };
  let api = {
    version: 2.7,
    hap,
    matter: {
      async unregisterPlatformAccessories() {
        calls.push('matter');
      },
    },
    isMatterEnabled() {
      return true;
    },
    unregisterPlatformAccessories() {
      calls.push('hap');
      throw new Error('HAP teardown failed');
    },
    on() {},
  };
  let device = new HomeKitDevice(
    [cachedHapAccessory, cachedMatterAccessory],
    api,
    deviceData('TEARDOWN'),
  );

  await device.remove();

  assert.deepEqual(calls, ['hap', 'matter']);
});

test('Homebridge supports Matter without creating a HAP accessory or AccessoryInformation service', async () => {
  let calls = {
    hapRegistered: [],
    matterRegistered: [],
    matterInformationUpdated: [],
  };
  let api = {
    version: 2.7,
    hap,
    matter: {
      deviceTypes: { OnOffSwitch: { name: 'OnOffSwitch' } },
      async registerPlatformAccessories(plugin, platform, accessories) {
        calls.matterRegistered.push({ plugin, platform, accessories });
      },
      async updatePlatformAccessories(accessories) {
        calls.matterInformationUpdated.push(accessories);
      },
    },
    isMatterEnabled() {
      return true;
    },
    platformAccessory: MockAccessory,
    registerPlatformAccessories(plugin, platform, accessories) {
      calls.hapRegistered.push({ plugin, platform, accessories });
    },
    updatePlatformAccessories() {},
    on() {},
  };

  class MatterOnlySwitch extends HomeKitDevice {
    onlineMessages = [];

    async onAdd() {
      assert.equal(calls.matterRegistered.length, 0);
      assert.equal(this.matterAccessory.UUID, this.uuid);
      assert.equal(this.matterAccessory.deviceType, this.matter.deviceTypes.OnOffSwitch);
      this.matterAccessory.clusters = { onOff: { onOff: false } };
    }

    async onMessage(type) {
      if (type === HomeKitDevice.ONLINE || type === HomeKitDevice.OFFLINE) {
        this.onlineMessages.push(type);
      }
    }
  }

  let device = new MatterOnlySwitch(undefined, api, { ...deviceData('MATTER-ONLY'), on: false });
  let added = await device.add({
    hapAccessoryName: null,
    matterDeviceType: api.matter.deviceTypes.OnOffSwitch,
  });

  assert.equal(device.accessory, undefined);
  assert.equal(added, true);
  assert.equal(calls.hapRegistered.length, 0);
  assert.equal(calls.matterRegistered.length, 1);
  assert.equal(calls.matterRegistered[0].accessories[0], device.matterAccessory);

  await device.update({
    description: 'Matter only switch',
    manufacturer: 'Updated manufacturer',
    model: 'Updated model',
    serialNumber: 'MATTER-ONLY-UPDATED',
    softwareVersion: '2.0.0',
    online: true,
  });

  assert.equal(device.deviceData.description, 'Matter only switch');
  assert.equal(device.matterAccessory.displayName, 'Matter only switch');
  assert.equal(device.matterAccessory.manufacturer, 'Updated manufacturer');
  assert.equal(device.matterAccessory.model, 'Updated model');
  assert.equal(device.matterAccessory.serialNumber, 'MATTER-ONLY-UPDATED');
  assert.equal(device.matterAccessory.firmwareRevision, '2.0.0');
  assert.equal(calls.matterInformationUpdated.length, 1);
  assert.equal(calls.matterInformationUpdated[0][0], device.matterAccessory);
  assert.deepEqual(device.onlineMessages, [HomeKitDevice.ONLINE]);

  await device.update({ description: 'Matter only switch' });

  assert.equal(calls.matterInformationUpdated.length, 1);
});

test('Homebridge add without arguments preserves the default HAP representation and persists metadata', async () => {
  let calls = { registered: [], updated: [], unregistered: [], shutdown: 0 };
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories(plugin, platform, accessories) {
      calls.registered.push({ plugin, platform, accessories });
      accessories[0]._associatedPlugin = plugin;
      accessories[0]._associatedPlatform = platform;
    },
    updatePlatformAccessories(accessories) {
      calls.updated.push(accessories);
    },
    unregisterPlatformAccessories(plugin, platform, accessories) {
      calls.unregistered.push({ plugin, platform, accessories });
    },
    on(event) {
      if (event === 'shutdown') {
        calls.shutdown += 1;
      }
    },
  };
  let device = new HomeKitDevice(undefined, api, deviceData('HAP-DEFAULT'));
  let added = await device.add();

  assert.equal(added, true);
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.shutdown, 1);

  await device.update({ description: 'Renamed HAP accessory' });

  assert.equal(device.accessory.displayName, 'Renamed HAP accessory');
  assert.equal(calls.updated.length, 1);

  await device.remove();

  assert.equal(calls.unregistered.length, 1);
});

for (let asynchronous of [false, true]) {
  test('HAP cache retries once within a message after a ' + (asynchronous === true ? 'rejected' : 'thrown') + ' write', async (context) => {
    let attempts = 0;
    let failuresRemaining = 0;
    let stored;
    let warnings = [];
    let api = {
      version: 2.7,
      hap,
      platformAccessory: MockAccessory,
      registerPlatformAccessories(plugin, platform, accessories) {
        assert.equal(plugin, HomeKitDevice.PLUGIN_NAME);
        accessories[0]._associatedPlatform = platform;
      },
      updatePlatformAccessories(accessories) {
        attempts += 1;
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          let error = new Error('HAP cache unavailable');
          if (asynchronous === true) {
            return Promise.reject(error);
          }
          throw error;
        }
        stored = structuredClone(accessories[0].context.HomeKitDevice);
      },
    };
    let device = new HomeKitDevice(undefined, api, { ...deviceData('HAP-RETRY-' + asynchronous), setting: 1 }, ['setting']);
    context.after(() => device.remove());
    assert.equal(await device.add(), true);
    device.log = { warn: (...args) => warnings.push(args) };
    attempts = 0;
    failuresRemaining = 1;

    assert.equal(await device.message(HomeKitDevice.UPDATE, { setting: 2 }), undefined);
    assert.equal(attempts, 2);
    assert.equal(device.deviceData.setting, 2);
    assert.deepEqual(stored, { setting: 2 });
    assert.equal(warnings.length, 1);

    // An unchanged message needs no cache write after successful persistence.
    await device.update({ setting: 2 });
    assert.equal(attempts, 2);

    // Persistent failures stop after two attempts and surface at the boundary.
    failuresRemaining = 2;
    await assert.rejects(device.message(HomeKitDevice.UPDATE, { setting: 3 }), /HAP cache unavailable/);
    assert.equal(attempts, 4);
    assert.equal(warnings.length, 3);
    assert.match(warnings[2][3], /HAP cache unavailable/);
    assert.deepEqual(stored, { setting: 2 });

    // A later change still persists the current state without remembered retries.
    await device.update({ setting: 4 });
    assert.equal(attempts, 5);
    assert.deepEqual(stored, { setting: 4 });
  });
}

test('Homebridge publishes external HAP only after onAdd completes', async () => {
  let calls = { registered: 0, unregistered: 0, updated: 0, published: 0, onAdd: 0 };
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      calls.registered += 1;
    },
    unregisterPlatformAccessories() {
      calls.unregistered += 1;
    },
    updatePlatformAccessories() {
      calls.updated += 1;
    },
    publishExternalAccessories(plugin, accessories) {
      calls.published += 1;
      assert.equal(plugin, HomeKitDevice.PLUGIN_NAME);
      assert.equal(accessories[0].configured, true);
      assert.equal(accessories[0].updated, true);
      accessories[0]._associatedPlugin = plugin;
    },
    on() {},
  };

  class ExternalTelevision extends HomeKitDevice {
    async onAdd() {
      calls.onAdd += 1;
      assert.equal(calls.registered, 0);
      assert.equal(calls.published, 0);
      assert.notEqual(this.accessory, undefined);
      this.accessory.configured = true;
    }

    async onUpdate() {
      this.accessory.updated = true;
    }
  }

  let device = new ExternalTelevision(undefined, api, deviceData('EXTERNAL-TV'));
  let added = await device.add({
    hapAccessoryName: 'Television',
    hapCategory: 31,
    externalPublish: true,
  });

  assert.equal(added, true);
  assert.equal(calls.onAdd, 1);
  assert.equal(calls.registered, 0);
  assert.equal(calls.updated, 0);
  assert.equal(calls.published, 1);

  await device.remove();

  assert.equal(calls.unregistered, 0);
});

test('Homebridge requires its external publishing API before external onAdd', async () => {
  let onAddCalls = 0;
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {},
    on() {},
  };

  class ExternalTelevision extends HomeKitDevice {
    async onAdd() {
      onAddCalls += 1;
    }
  }

  let device = new ExternalTelevision(undefined, api, deviceData('EXTERNAL-UNAVAILABLE'));

  assert.equal(await device.add({ hapAccessoryName: 'Television', externalPublish: true }), undefined);
  assert.equal(device.accessory, undefined);
  assert.equal(onAddCalls, 0);
});

test('independent HAP publication failures use the same failure path', async () => {
  let homebridgeApi = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    publishExternalAccessories() {
      throw new Error('External publish failed');
    },
    on() {},
  };
  let externalDevice = new HomeKitDevice(undefined, homebridgeApi, deviceData('EXTERNAL-PUBLISH-FAILED'));

  assert.equal(await externalDevice.add({ hapAccessoryName: 'Television', externalPublish: true }), false);
  assert.equal(externalDevice.accessory, undefined);

  class FailingAccessory extends MockAccessory {
    async publish() {
      throw new Error('Standalone publish failed');
    }
  }

  let standaloneHap = {
    ...hap,
    Accessory: FailingAccessory,
    HAPLibraryVersion() {
      return '2.0.0';
    },
  };
  let standaloneDevice = new HomeKitDevice(undefined, standaloneHap, {
    ...deviceData('STANDALONE-PUBLISH-FAILED'),
    hkUsername: '11:22:33:44:55:77',
    hkPairingCode: '123-45-678',
  });

  assert.equal(
    await standaloneDevice.add({ hapAccessoryName: 'Switch', hapCategory: standaloneHap.Categories.SWITCH }),
    false,
  );
  assert.equal(standaloneDevice.accessory, undefined);

  await externalDevice.remove();
  await standaloneDevice.remove();
});

test('Homebridge does not call onAdd when HAP registration leaves no usable representation', async () => {
  let onAddCalls = 0;
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      throw new Error('HAP unavailable');
    },
    on() {},
  };

  class UnregisteredHapSwitch extends HomeKitDevice {
    async onAdd() {
      onAddCalls += 1;
    }
  }

  let device = new UnregisteredHapSwitch(undefined, api, deviceData('HAP-REGISTRATION-FAILED'));

  assert.equal(await device.add({ hapAccessoryName: 'Switch' }), false);
  assert.equal(device.accessory, undefined);
  assert.equal(device.matterAccessory, undefined);
  assert.equal(onAddCalls, 0);

  await device.remove();
});

test('setup logging uses the requested HAP accessory name when present', async () => {
  let successCalls = [];
  let originalLogger = HomeKitDevice.LOGGER;
  HomeKitDevice.LOGGER = {
    success(...args) {
      successCalls.push(args);
    },
  };

  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {},
    on() {},
  };

  try {
    let namedDevice = new HomeKitDevice(undefined, api, deviceData('NAMED-SETUP'));
    assert.equal(await namedDevice.add({ hapAccessoryName: 'Switch' }), true);

    let unnamedDevice = new HomeKitDevice(undefined, api, deviceData('UNNAMED-SETUP'));
    assert.equal(await unnamedDevice.add(), true);

    assert.deepEqual(successCalls, [
      ['Setup %s as "%s"', 'Switch', 'Device NAMED-SETUP'],
      ['Setup "%s"', 'Device UNNAMED-SETUP'],
    ]);
  } finally {
    HomeKitDevice.LOGGER = originalLogger;
  }
});

test('Homebridge degrades to HAP when optional Matter registration fails', async () => {
  let calls = { hapRegistered: 0, matterInformationUpdated: 0 };
  let api = {
    version: 2.7,
    hap,
    matter: {
      deviceTypes: { OnOffSwitch: { name: 'OnOffSwitch' } },
      async registerPlatformAccessories() {
        throw new Error('Matter unavailable');
      },
      async updatePlatformAccessories() {
        calls.matterInformationUpdated += 1;
      },
    },
    isMatterEnabled() {
      return true;
    },
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      calls.hapRegistered += 1;
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories() {},
    on() {},
  };

  class OptionalMatterSwitch extends HomeKitDevice {
    async onAdd() {
      assert.equal(this.matterAccessory.deviceType, this.matter.deviceTypes.OnOffSwitch);
      this.matterAccessory.clusters = { onOff: { onOff: false } };
    }
  }

  let device = new OptionalMatterSwitch(undefined, api, deviceData('HAP-FALLBACK'));
  let added = await device.add({
    hapAccessoryName: 'Switch',
    matterDeviceType: api.matter.deviceTypes.OnOffSwitch,
  });

  assert.equal(added, true);
  assert.equal(device.matterAccessory, undefined);
  assert.equal(calls.hapRegistered, 1);
  assert.equal(calls.matterInformationUpdated, 0);

  await device.remove();
});

test('Matter-only add fails cleanly when Matter cannot be registered', async () => {
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      throw new Error('HAP must not be registered');
    },
    updatePlatformAccessories() {},
    on() {},
  };

  let device = new HomeKitDevice(undefined, api, deviceData('MATTER-UNAVAILABLE'));

  assert.equal(await device.add({ hapAccessoryName: null, matterDeviceType: {} }), undefined);
  assert.equal(device.accessory, undefined);
  assert.equal(device.matterAccessory, undefined);

  await device.remove();
});

test('Homebridge does not register or remove a cached HAP accessory when setup fails', async () => {
  let calls = { registered: 0, unregistered: 0 };
  let cachedHapAccessory = new MockAccessory('Cached HAP accessory', 'uuid:homebridge-example_HAP-ROLLBACK');
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      calls.registered += 1;
    },
    unregisterPlatformAccessories() {
      calls.unregistered += 1;
    },
    updatePlatformAccessories() {},
    on() {},
  };

  let setupError = new Error('Setup failed');
  class BrokenHapSwitch extends HomeKitDevice {
    async onAdd() {
      throw setupError;
    }
  }

  let device = new BrokenHapSwitch(cachedHapAccessory, api, deviceData('HAP-ROLLBACK'));

  await assert.rejects(device.add(), (error) => error === setupError);
  assert.equal(device.accessory, cachedHapAccessory);
  assert.equal(calls.registered, 0);
  assert.equal(calls.unregistered, 0);

  await device.remove();
  assert.equal(calls.unregistered, 1);
});

test('initial UPDATE rejection stops external publication and forwards its original error', async (context) => {
  let failure = new Error('Initial update failed');
  let published = 0;
  let errors = [];
  let cachedAccessory = new MockAccessory('Cached', 'uuid:homebridge-example_INITIAL-REJECTION');
  let device = new HomeKitDevice(cachedAccessory, {
    version: 2.7,
    hap,
    publishExternalAccessories() {
      published += 1;
    },
  }, deviceData('INITIAL-REJECTION'));
  context.after(() => device.remove());
  device.log = { error: (...args) => errors.push(args) };
  device.onUpdate = async () => {
    await setImmediate();
    throw failure;
  };

  await assert.rejects(device.add({ externalPublish: true }), (error) => error === failure);
  assert.equal(published, 0);
  assert.equal(device.accessory, cachedAccessory);
  assert.deepEqual(errors, [['Accessory setup failed for "%s"', device.deviceData.description]]);
});

// Lifecycle hooks must walk every override, retaining the device as the receiver.
test('overlapping UPDATE routes preserve committed fields and run hooks in submission order', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('OVERLAP'), a: 0, b: 0 });
  context.after(() => device.remove());
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let snapshots = [];
  device.onUpdate = async (data) => {
    snapshots.push({ a: data.a, b: data.b });
    if (snapshots.length === 1) {
      entered.resolve();
      await release.promise;
    }
  };

  let first = device.update({ a: 1 });
  await entered.promise;
  let second = HomeKitDevice.message(device.uuid, HomeKitDevice.UPDATE, { b: 1 });
  await setImmediate();
  assert.deepEqual(snapshots, [{ a: 1, b: 0 }]);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, [{ a: 1, b: 0 }, { a: 1, b: 1 }]);
  assert.equal(device.deviceData.a, 1);
  assert.equal(device.deviceData.b, 1);
});

test('lifecycle ordering includes HAP cache writes while other devices continue', { timeout: 1000 }, async (context) => {
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let holdCache = false;
  let stored;
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories(plugin, platform, accessories) {
      accessories[0]._associatedPlatform = platform;
    },
    async updatePlatformAccessories(accessories) {
      if (holdCache === true) {
        holdCache = false;
        entered.resolve();
        await release.promise;
      }
      stored = structuredClone(accessories[0].context.HomeKitDevice);
    },
  };
  let device = new HomeKitDevice(undefined, api, { ...deviceData('CACHE-ORDER'), a: 0, b: 0 }, ['a', 'b']);
  let other = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('INDEPENDENT-ORDER'), a: 0 });
  context.after(() => device.remove());
  context.after(() => other.remove());
  assert.equal(await device.add(), true);
  let snapshots = [];
  device.onUpdate = (data) => snapshots.push({ a: data.a, b: data.b });
  holdCache = true;

  let first = device.update({ a: 1 });
  await entered.promise;
  assert.equal(device.deviceData.a, 1);
  let second = device.update({ b: 1 });
  await other.update({ a: 2 });
  assert.equal(other.deviceData.a, 2);
  assert.deepEqual(snapshots, [{ a: 1, b: 0 }]);
  assert.deepEqual(device.accessory.context.HomeKitDevice, { a: 1, b: 0 });
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(stored, { a: 1, b: 1 });
  assert.deepEqual(snapshots, [{ a: 1, b: 0 }, { a: 1, b: 1 }]);
});

test('UPDATE waits for preceding SET and merges its committed state', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('SET-OVERLAP'), a: 0, b: 0 });
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(async () => {
    release.resolve();
    await device.remove();
  });
  device.onSet = async () => {
    entered.resolve();
    await release.promise;
  };
  let snapshots = [];
  device.onUpdate = (data) => snapshots.push({ a: data.a, b: data.b });
  let first = device.set({ a: 1 });
  await entered.promise;
  let second = device.update({ b: 1 });
  await setImmediate();
  assert.deepEqual(snapshots, []);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, [{ a: 1, b: 1 }]);
});

for (let type of [HomeKitDevice.GET, HomeKitDevice.TIMER, 'custom']) {
  test(type + ' waits for earlier messages on the same device', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('QUEUE-' + type), a: 0 });
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    context.after(async () => {
      release.resolve();
      await device.remove();
    });
    let calls = [];
    device.onUpdate = async () => {
      entered.resolve();
      await release.promise;
      calls.push('update');
    };
    let handler = () => {
      assert.equal(device.deviceData.a, 1);
      calls.push(type);
      return 42;
    };
    device.onGet = handler;
    device.onTimer = handler;
    device.onMessage = handler;
    let updating = device.update({ a: 1 });
    await entered.promise;
    let queued = device.message(type, {});
    await setImmediate();
    assert.deepEqual(calls, []);
    release.resolve();
    assert.equal(await queued, 42);
    await updating;
    assert.deepEqual(calls, ['update', type]);
  });
}

test('onUpdate can await history with validation, duplicate filtering and all handlers', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('OWNED-HISTORY'));
  context.after(() => device.remove());
  let target = { UUID: 'history-target' };
  let calls = [];
  let last;
  device.historyService = {
    lastHistory: () => last,
    addHistory(service, entry, gap) {
      assert.equal(service, target);
      assert.equal(Number.isFinite(entry.time), true);
      assert.equal(gap, 5);
      last = entry;
      calls.push('store');
      return true;
    },
  };
  device.onHistory = (service, entry) => {
    assert.equal(service, target);
    assert.equal(entry.status, 1);
    calls.push('hook');
  };
  HomeKitDevice.message(device.uuid, HomeKitDevice.HISTORY, () => calls.push('listener'));
  device.onUpdate = async () => {
    await device.history(null, { status: 1 });
    await device.history(target, { status: 1 }, null);
    await device.history(target, { status: 1 }, { timegap: 5 });
    await device.history(target, { status: 1 }, { timegap: 5 });
    calls.push('update');
  };
  await device.update({ a: 1 });
  assert.deepEqual(calls, ['store', 'hook', 'listener', 'update']);
});

for (let method of ['remove', 'shutdown']) {
  test(method + ' waits for history submitted without awaiting from onUpdate', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('OWNED-HISTORY-' + method));
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    context.after(async () => {
      release.resolve();
      await device.remove();
    });
    let calls = [];
    device.historyService = {
      async addHistory() {
        entered.resolve();
        await release.promise;
        calls.push('store');
        return true;
      },
    };
    device.onHistory = () => calls.push('history');
    device.onUpdate = () => {
      device.history({ UUID: 'history-target' }, { status: 1 });
    };
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => calls.push(method);
    let updating = device.update({ a: 1 });
    await entered.promise;
    let teardown = device[method]();
    await setImmediate();
    assert.deepEqual(calls, []);
    release.resolve();
    await Promise.all([updating, teardown]);
    assert.deepEqual(calls, ['store', 'history', method]);
  });
}

test('overlapping nested history entries finish in submission order', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('OWNED-HISTORY-ORDER'));
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(async () => {
    release.resolve();
    await device.remove();
  });
  let calls = [];
  device.historyService = {
    async addHistory(target, entry) {
      calls.push('start ' + entry.status);
      if (entry.status === 1) {
        entered.resolve();
        await release.promise;
      }
      calls.push('finish ' + entry.status);
      return true;
    },
  };
  device.onUpdate = () => {
    device.history({ UUID: 'history-target' }, { status: 1 });
    device.history({ UUID: 'history-target' }, { status: 2 });
  };
  let updating = device.update({ a: 1 });
  await entered.promise;
  await setImmediate();
  assert.deepEqual(calls, ['start 1']);
  release.resolve();
  await updating;
  assert.deepEqual(calls, ['start 1', 'finish 1', 'start 2', 'finish 2']);
});

for (let method of ['remove', 'shutdown']) {
  test('history owned by ' + method + ' finishes before cleanup', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('TEARDOWN-HISTORY-' + method));
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    context.after(async () => {
      release.resolve();
      await device.remove();
    });
    let historyService = {
      async addHistory() {
        entered.resolve();
        await release.promise;
        return true;
      },
    };
    device.historyService = historyService;
    let completed = false;
    device.onHistory = () => {
      assert.equal(device.historyService, historyService);
      assert.equal(device.hap, hap);
      completed = true;
    };
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => {
      device.history({ UUID: 'history-target' }, { status: 1 });
    };
    let teardown = device[method]();
    await entered.promise;
    assert.equal(device.historyService, historyService);
    assert.equal(completed, false);
    release.resolve();
    await teardown;
    assert.equal(completed, true);
  });
}

for (let awaited of [true, false]) {
  test('nested history failure rejects its owner and the queue recovers, awaited: ' + awaited, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('OWNED-HISTORY-FAIL-' + awaited));
    context.after(() => device.remove());
    let failure = new Error('History hook failed');
    device.historyService = { addHistory: () => true };
    device.onHistory = () => {
      throw failure;
    };
    device.onUpdate = async () => {
      let history = device.history({ UUID: 'history-target' }, { status: 1 });
      if (awaited === true) {
        await history;
      }
    };
    await assert.rejects(device.update({ a: 1 }), (error) => error === failure);
    delete device.onHistory;
    await device.update({ a: 2 });
    assert.equal(device.deviceData.a, 2);
  });
}

test('nested GET, HISTORY and custom handlers share ownership without bypassing state-change guards', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('OWNED-NESTED-ROUTES'));
  context.after(() => device.remove());
  let calls = [];
  device.historyService = { addHistory: () => true };
  device.onMessage = (type) => {
    calls.push(type);
    return 42;
  };
  device.onHistory = async () => {
    assert.equal(await device.message('custom', {}), 42);
    await assert.rejects(device.update({ a: 99 }), /Reentrant lifecycle message/);
    calls.push('history');
  };
  device.onGet = async () => {
    await device.history({ UUID: 'history-target' }, { status: 1 });
    calls.push('get');
    return { value: 1 };
  };
  device.onUpdate = async () => {
    assert.deepEqual(await device.get({}), { value: 1 });
    calls.push('update');
  };
  await device.update({ a: 1 });
  assert.deepEqual(calls, ['custom', 'history', 'get', 'update']);
  assert.equal(device.deviceData.a, 1);
});

for (let type of [HomeKitDevice.TIMER, HomeKitDevice.GET, 'plugin-command']) {
  test('nested state work uses generic ownership under ' + type, { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('NESTED-STATE-' + type), a: 0, b: 0 });
    context.after(() => device.remove());
    let calls = [];
    device.historyService = { addHistory: () => calls.push('history') };
    device.onUpdate = async () => {
      await device.history({ UUID: 'history-target' }, { status: 1 });
      calls.push('update');
    };
    device.onSet = () => calls.push('set');
    await HomeKitDevice.message(device.uuid, type, async () => {
      await device.update({ a: 1 });
      await device.set({ b: 2 });
      return 42;
    });
    assert.equal(await device.message(type, {}), 42);
    assert.deepEqual(calls, ['history', 'update', 'set']);
    assert.equal(device.deviceData.a, 1);
    assert.equal(device.deviceData.b, 2);
  });
}

test('polling can await GET then UPDATE while external teardown waits for the entire operation', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('NESTED-POLLING'), a: 0 });
  context.after(() => device.remove());
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(() => release.resolve());
  let calls = [];
  device.onGet = async () => {
    entered.resolve();
    await release.promise;
    return { a: 1 };
  };
  device.onTimer = async () => {
    await device.update(await device.get({}));
    calls.push('timer');
  };
  device.onUpdate = () => calls.push('update');
  device.onShutdown = () => calls.push('shutdown');
  let polling = device.message(HomeKitDevice.TIMER);
  await entered.promise;
  let shutdown = device.shutdown();
  await setImmediate();
  assert.deepEqual(calls, []);
  release.resolve();
  await Promise.all([polling, shutdown]);
  assert.deepEqual(calls, ['update', 'timer', 'shutdown']);
  assert.equal(device.deviceData.a, 1);
});

test('ignored nested SET and UPDATE remain ordered before external work', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('NESTED-IGNORED-STATE'), a: 0, b: 0 });
  context.after(() => device.remove());
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(() => release.resolve());
  let calls = [];
  device.onSet = async () => {
    entered.resolve();
    await release.promise;
    calls.push('set');
  };
  device.onUpdate = (data) => calls.push([data.a, data.b]);
  device.onMessage = () => {
    device.set({ a: 1 });
    device.update({ b: 2 });
  };
  let command = device.message('plugin-command');
  await entered.promise;
  let external = device.update({ b: 3 });
  await setImmediate();
  assert.deepEqual(calls, []);
  release.resolve();
  await Promise.all([command, external]);
  assert.deepEqual(calls, ['set', [1, 2], [1, 3]]);
  assert.equal(device.deviceData.a, 1);
  assert.equal(device.deviceData.b, 3);
});

test('ignored nested write failures reject the owner without leaving unobserved wrapper promises', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('IGNORED-STATE-FAILURE'), a: 0 });
  context.after(() => device.remove());
  let failure = new Error('Device write failed');
  device.onSet = () => {
    throw failure;
  };
  device.onMessage = () => {
    device.set({ a: 1 });
  };
  await assert.rejects(device.message('plugin-command'), (error) => error === failure);
  await setImmediate();
  assert.equal(device.deviceData.a, 0);
  delete device.onSet;
  await device.update({ a: 2 });
  assert.equal(device.deviceData.a, 2);
});

test('inherited context from a finished child rejoins the active owner in submission order', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('FINISHED-STATE-OWNER'), a: 0, b: 0 });
  context.after(() => device.remove());
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(() => release.resolve());
  let inherited;
  let calls = [];
  device.onUpdate = (data) => {
    inherited ??= AsyncLocalStorage.snapshot();
    calls.push([data.a, data.b]);
  };
  device.onSet = async () => {
    entered.resolve();
    await release.promise;
    calls.push('set');
  };
  device.onMessage = async () => {
    await device.update({ a: 1 });
    let set = device.set({ a: 2 });
    await entered.promise;
    // The captured UPDATE context has finished; its active parent owns this submission.
    let update = inherited(() => device.update({ b: 3 }));
    await setImmediate();
    assert.deepEqual(calls, [[1, 0]]);
    release.resolve();
    await Promise.all([set, update]);
  };
  await device.message('plugin-command');
  assert.deepEqual(calls, [[1, 0], 'set', [2, 3]]);
});

test('SET ownership protects its delayed commit from a nested UPDATE', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('SET-STATE-OWNER'), a: 0, b: 0 });
  context.after(() => device.remove());
  let updates = 0;
  device.onUpdate = () => updates += 1;
  device.onSet = () => device.update({ a: 2, b: 2 });
  await assert.rejects(device.set({ a: 1 }), /Reentrant lifecycle message/);
  assert.equal(updates, 0);
  assert.equal(device.deviceData.a, 0);
  assert.equal(device.deviceData.b, 0);
});

test('indirect nested state changes cannot take ownership from an unfinished commit', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('INDIRECT-STATE-OWNER'), a: 0, b: 0 });
  context.after(() => device.remove());
  device.onMessage = () => device.set({ b: 2 });
  device.onUpdate = () => device.message('plugin-command');
  await assert.rejects(device.update({ a: 1 }), /Reentrant lifecycle message/);
  assert.equal(device.deviceData.a, 1);
  assert.equal(device.deviceData.b, 0);
});

for (let method of ['remove', 'shutdown']) {
  test('nested ' + method + ' finishes cleanup and prevents later owned state work', async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('NESTED-TEARDOWN-' + method), a: 0 });
    context.after(() => device.remove());
    device.historyService = { addHistory: () => true };
    let histories = 0;
    let updates = 0;
    device.onHistory = () => histories += 1;
    device.onUpdate = () => updates += 1;
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => device.history({ UUID: 'history-target' }, { status: 1 });
    device.onMessage = async () => {
      await device[method]();
      await device.update({ a: 99 });
    };
    await device.message('plugin-command');
    assert.equal(histories, 1);
    assert.equal(updates, 0);
    assert.notEqual(device.deviceData.a, 99);
  });
}

test('recursive history rejects instead of deadlocking its owning dispatch', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('RECURSIVE-HISTORY'));
  context.after(() => device.remove());
  device.historyService = { addHistory: () => true };
  device.onHistory = () => device.history({ UUID: 'history-target' }, { status: 2 });
  device.onUpdate = () => device.history({ UUID: 'history-target' }, { status: 1 });
  await assert.rejects(device.update({ a: 1 }), /Reentrant lifecycle message/);
});

test('global shutdown isolates a stalled device queue and a rejecting shutdown hook', { timeout: 1000 }, async (context) => {
  let devices = ['STALLED', 'HEALTHY', 'REJECTING'].map((name) => new HomeKitDevice(
    undefined, { version: 2.7, hap }, deviceData('SHUTDOWN-ISOLATION-' + name),
  ));
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(async () => {
    release.resolve();
    await Promise.all(devices.map((device) => device.remove()));
  });
  let calls = [];
  devices[0].onUpdate = async () => {
    entered.resolve();
    await release.promise;
  };
  devices[0].onShutdown = () => calls.push('stalled');
  devices[1].onShutdown = () => calls.push('healthy');
  devices[2].onShutdown = () => {
    calls.push('rejecting');
    throw new Error('Shutdown hook failed');
  };
  let updating = devices[0].update({ a: 1 });
  await entered.promise;
  let shutdown = HomeKitDevice.shutdown();
  await setImmediate();
  assert.deepEqual(calls, ['healthy', 'rejecting']);
  release.resolve();
  await Promise.all([updating, shutdown]);
  assert.deepEqual(calls, ['healthy', 'rejecting', 'stalled']);
});

test('overlapping runtime shutdown events broadcast once and invoke each device hook once', { timeout: 1000 }, async (context) => {
  let broadcasts = 0;
  let originalShutdown = HomeKitDevice.shutdown;
  HomeKitDevice.shutdown = async () => {
    broadcasts += 1;
    await originalShutdown();
  };
  context.after(() => {
    HomeKitDevice.shutdown = originalShutdown;
  });
  let shutdown;
  let registrations = 0;
  let api = {
    version: 2.7,
    hap,
    on(event, callback) {
      assert.equal(event, 'shutdown');
      registrations += 1;
      shutdown = callback;
    },
  };
  let first = new HomeKitDevice(undefined, api, deviceData('RUNTIME-SHUTDOWN-FIRST'));
  let second = new HomeKitDevice(undefined, api, deviceData('RUNTIME-SHUTDOWN-SECOND'));
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  context.after(async () => {
    release.resolve();
    await Promise.all([first.remove(), second.remove()]);
  });
  let calls = [0, 0];
  first.onShutdown = async () => {
    calls[0] += 1;
    entered.resolve();
    await release.promise;
  };
  second.onShutdown = () => {
    calls[1] += 1;
  };
  assert.equal(registrations, 1);
  let initial = shutdown();
  await entered.promise;
  let overlapping = shutdown();
  release.resolve();
  await Promise.all([initial, overlapping]);
  await shutdown();
  await Promise.all([first.shutdown(), second.shutdown()]);
  assert.equal(broadcasts, 1);
  assert.deepEqual(calls, [1, 1]);
});

for (let method of ['remove', 'shutdown']) {
  test(method + ' follows pending UPDATE and prevents later state changes', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('ORDER-' + method), a: 0, b: 0 });
    context.after(() => device.remove());
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    let calls = [];
    device.addTimer('poll', { interval: 10000 }, () => {});
    device.onUpdate = async () => {
      calls.push('update');
      entered.resolve();
      await release.promise;
    };
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => {
      calls.push(method);
      assert.equal(device.deviceData.a, 1);
    };
    device.onSet = () => calls.push('set');

    let first = device.update({ a: 1 });
    await entered.promise;
    let teardown = device[method]();
    let lateUpdate = device.message(HomeKitDevice.UPDATE, { b: 1 });
    let lateSet = device.set({ b: 2 });
    await setImmediate();
    assert.deepEqual(calls, ['update']);
    release.resolve();
    await Promise.all([first, teardown, lateUpdate, lateSet]);
    assert.deepEqual(calls, ['update', method]);
    assert.equal(device.hasTimer('poll'), false);
    if (method === 'remove') {
      assert.deepEqual(device.deviceData, {});
      assert.equal(device.uuid, undefined);
    } else {
      assert.equal(device.deviceData.a, 1);
      assert.equal(device.deviceData.b, 0);
    }
    await device[method]();
    assert.deepEqual(calls, ['update', method]);
  });
}

test('a failed UPDATE rejects its caller without blocking queued updates', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('FAILED-OVERLAP'), a: 0, b: 0 });
  context.after(() => device.remove());
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let failure = new Error('Update hook failed');
  device.onUpdate = async (data) => {
    if (data.b === 0) {
      entered.resolve();
      await release.promise;
      throw failure;
    }
  };
  let first = assert.rejects(device.update({ a: 1 }), (error) => error === failure);
  await entered.promise;
  let second = device.update({ b: 1 });
  release.resolve();
  await Promise.all([first, second]);
  // UPDATE retains its existing commit-after-hook-failure behaviour.
  assert.equal(device.deviceData.a, 1);
  assert.equal(device.deviceData.b, 1);
});

for (let type of [HomeKitDevice.UPDATE, HomeKitDevice.SET, HomeKitDevice.REMOVE, HomeKitDevice.SHUTDOWN]) {
  test('reentrant ' + type + ' rejects without deadlocking or changing nested state', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('REENTRANT-' + type), a: 0, b: 0 });
    context.after(() => device.remove());
    let nestedFailure;
    device.onUpdate = async () => {
      await setImmediate();
      try {
        await HomeKitDevice.message(device.uuid, type, { b: 1 });
      } catch (error) {
        nestedFailure = error;
        throw error;
      }
    };
    await assert.rejects(device.update({ a: 1 }), /Reentrant lifecycle message/);
    assert.match(nestedFailure.message, /Reentrant lifecycle message/);
    assert.equal(device.deviceData.a, 1);
    assert.equal(device.deviceData.b, 0);
    delete device.onUpdate;
    await device.update({ b: 2 });
    assert.equal(device.deviceData.b, 2);
  });
}

test('hooks can update another device but a lifecycle cycle rejects', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('CYCLE-FIRST'), a: 0, b: 0 });
  let other = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('CYCLE-SECOND'), a: 0 });
  context.after(() => device.remove());
  context.after(() => other.remove());
  device.onUpdate = () => other.update({ a: 1 });
  await device.update({ a: 1 });
  assert.equal(other.deviceData.a, 1);

  other.onUpdate = () => device.update({ b: 1 });
  device.onUpdate = () => other.update({ a: 2 });
  await assert.rejects(device.update({ a: 2 }), /Reentrant lifecycle message/);
  assert.equal(device.deviceData.a, 2);
  assert.equal(device.deviceData.b, 0);
  assert.equal(other.deviceData.a, 2);
});

test('setup initial UPDATE finishes before a queued external UPDATE', { timeout: 1000 }, async (context) => {
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories(plugin, platform, accessories) {
      accessories[0]._associatedPlatform = platform;
    },
    updatePlatformAccessories() {},
  };
  let device = new HomeKitDevice(undefined, api, { ...deviceData('SETUP-ORDER'), a: 0 });
  context.after(() => device.remove());
  let snapshots = [];
  device.onAdd = async () => {
    entered.resolve();
    await release.promise;
  };
  device.onUpdate = (data) => snapshots.push(data.a);
  let adding = device.add();
  await entered.promise;
  let updating = device.update({ a: 1 });
  await setImmediate();
  assert.deepEqual(snapshots, []);
  release.resolve();
  assert.deepEqual(await Promise.all([adding, updating]), [true, undefined]);
  assert.deepEqual(snapshots, [0, 1]);
  assert.equal(device.deviceData.a, 1);
});

for (let method of ['remove', 'shutdown']) {
  test(method + ' waits for pending Matter registration and setup publication', { timeout: 1000 }, async (context) => {
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    let registered = new Set();
    let calls = [];
    let api = {
      version: 2.7,
      hap,
      platformAccessory: MockAccessory,
      publishExternalAccessories() {
        calls.push('publish');
      },
      unregisterPlatformAccessories() {},
      isMatterEnabled() {
        return true;
      },
      matter: {
        async registerPlatformAccessories(plugin, platform, accessories) {
          calls.push('register:start');
          entered.resolve();
          await release.promise;
          registered.add(accessories[0].UUID);
          calls.push('register:end');
        },
        unregisterPlatformAccessories(plugin, platform, accessories) {
          registered.delete(accessories[0].UUID);
          calls.push('unregister');
        },
      },
    };
    let device = new HomeKitDevice(undefined, api, deviceData('SETUP-' + method));
    let uuid = device.uuid;
    context.after(() => device.remove());
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => calls.push(method);
    let adding = device.add({ externalPublish: true, matterDeviceType: { name: 'Switch' } });
    await entered.promise;
    let tearingDown = device[method]();
    await setImmediate();
    assert.deepEqual(calls, ['register:start']);
    release.resolve();
    assert.deepEqual(await Promise.all([adding, tearingDown]), [true, undefined]);
    assert.deepEqual(calls.slice(0, 4), ['register:start', 'register:end', 'publish', method]);
    if (method === 'remove') {
      assert.equal(registered.has(uuid), false);
      assert.equal(device.uuid, undefined);
      assert.deepEqual(device.deviceData, {});
    } else {
      assert.equal(registered.has(uuid), true);
      await device.remove();
      assert.equal(registered.has(uuid), false);
    }
  });
}

test('REMOVE waits for standalone HAP publication before unpublishing', { timeout: 1000 }, async (context) => {
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let calls = [];
  class SlowAccessory extends MockAccessory {
    async publish() {
      calls.push('publish:start');
      entered.resolve();
      await release.promise;
      await super.publish();
      calls.push('publish:end');
    }

    async unpublish() {
      calls.push('unpublish');
      await super.unpublish();
    }
  }
  let api = { ...hap, Accessory: SlowAccessory, HAPLibraryVersion: () => 'test' };
  let device = new HomeKitDevice(undefined, api, {
    ...deviceData('SETUP-PUBLISH'), hkUsername: 'AA:BB:CC:DD:EE:FF', hkPairingCode: '123-45-678',
  });
  context.after(() => device.remove());
  let adding = device.add({ hapAccessoryName: 'Publish', hapCategory: hap.Categories.SWITCH });
  await entered.promise;
  let accessory = device.accessory;
  let removing = device.remove();
  await setImmediate();
  assert.deepEqual(calls, ['publish:start']);
  release.resolve();
  assert.deepEqual(await Promise.all([adding, removing]), [true, undefined]);
  assert.deepEqual(calls, ['publish:start', 'publish:end', 'unpublish']);
  assert.equal(accessory.unpublished, true);
  assert.equal(device.accessory, undefined);
});

test('reentrant add rejects before creating or registering protocol resources', { timeout: 1000 }, async (context) => {
  let registrations = 0;
  let api = {
    version: 2.7,
    hap,
    platformAccessory: MockAccessory,
    registerPlatformAccessories() {
      registrations += 1;
    },
  };
  let device = new HomeKitDevice(undefined, api, { ...deviceData('REENTRANT-SETUP'), a: 0 });
  context.after(() => device.remove());
  device.onUpdate = () => device.add();
  await assert.rejects(device.update({ a: 1 }), /Reentrant lifecycle message/);
  assert.equal(registrations, 0);
  assert.equal(device.accessory, undefined);
});

test('a hook-created timer callback queues its independent UPDATE',
  { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('TIMER-CONTEXT'), a: 0, b: 0 });
    context.after(() => device.remove());
    let submitted = Promise.withResolvers();
    let release = Promise.withResolvers();
    let timerUpdate;
    let fire = () => {
      timerUpdate = device.update({ b: 1 });
      submitted.resolve();
      return timerUpdate;
    };
    device.onUpdate = async (data) => {
      if (data.b === 0) {
        device.addTimer('independent', { delay: 1 }, fire);
        await release.promise;
      }
    };
    let updating = device.update({ a: 1 });
    await submitted.promise;
    // The timer submits during the suspended hook; its UPDATE waits its turn.
    assert.equal(device.deviceData.a, 0);
    assert.equal(device.deviceData.b, 0);
    release.resolve();
    await Promise.all([updating, timerUpdate]);
    assert.equal(device.deviceData.a, 1);
    assert.equal(device.deviceData.b, 1);
  });for (let size of [2, 3]) {
  test(size + ' independent device dispatches reject a wait cycle and recover their queues', { timeout: 1000 }, async (context) => {
    let devices = Array.from({ length: size }, (_, index) => new HomeKitDevice(
      undefined, { version: 2.7, hap }, { ...deviceData('WAIT-' + size + '-' + index), a: 0 },
    ));
    let entered = devices.map(() => Promise.withResolvers());
    for (let [index, device] of devices.entries()) {
      context.after(() => device.remove());
      device.onUpdate = async (data) => {
        if (data.a === 1) {
          entered[index].resolve();
          await Promise.all(entered.map((gate) => gate.promise));
          await devices[(index + 1) % size].update({ a: 2 });
        }
      };
    }
    let results = await Promise.allSettled(devices.map((device) => device.update({ a: 1 })));
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /cross-device wait cycle/);
    await Promise.all(devices.map((device) => device.update({ a: 3 })));
    assert.deepEqual(devices.map((device) => device.deviceData.a), devices.map(() => 3));
  });
}

test('async work created by a completed hook can submit a later UPDATE', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('INHERITED-CONTEXT'), a: 0, b: 0 });
  context.after(() => device.remove());
  let release = Promise.withResolvers();
  let later;
  device.onUpdate = (data) => {
    if (data.b === 0) {
      later = release.promise.then(() => device.update({ b: 1 }));
    }
  };
  await device.update({ a: 1 });
  release.resolve();
  await later;
  assert.equal(device.deviceData.a, 1);
  assert.equal(device.deviceData.b, 1);
});

for (let method of ['onAdd', 'onUpdate', 'onRemove', 'onShutdown', 'onSet', 'onGet', 'onHistory', 'onTimer', 'onProbe']) {
  test(method + ' invokes instance and prototype hooks sequentially before registered handlers', async (context) => {
    let calls = [];
    class BaseDevice extends HomeKitDevice {}
    class MiddleDevice extends BaseDevice {}
    class LeafDevice extends MiddleDevice {}
    let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-' + method));
    context.after(() => {
      if (method !== 'onRemove') {
        return device.remove();
      }
    });
    let payload = { requested: true };
    let extra = { extra: true };
    let target = { UUID: 'history-target' };
    let options = { force: true };
    device.historyService = { addHistory: () => true };

    // These closures intentionally have identical source but distinct identities.
    let hook = (level) => async function (...args) {
      assert.equal(this, device);
      if (method === 'onHistory') {
        assert.deepEqual(args, [target, payload, options]);
      } else {
        assert.equal(args[0].requested, true);
        assert.equal(args[1], extra);
      }
      calls.push(level + ':start');
      await setImmediate();
      calls.push(level + ':end');
    };
    BaseDevice.prototype[method] = hook('base');
    MiddleDevice.prototype[method] = hook('middle');
    LeafDevice.prototype[method] = hook('leaf');
    device[method] = hook('instance');
    let type = 'HomeKitDevice.' + method;
    await HomeKitDevice.message(device.uuid, type, hook('registered'));

    if (method === 'onHistory') {
      await device.message(type, target, payload, options);
    } else {
      await device.message(type, payload, extra);
    }

    assert.deepEqual(calls, [
      'instance:start', 'instance:end', 'leaf:start', 'leaf:end',
      'middle:start', 'middle:end', 'base:start', 'base:end',
      'registered:start', 'registered:end',
    ]);
  });
}

test('an inherited hook runs once across prototypes without their own override', async (context) => {
  let calls = 0;
  class BaseDevice extends HomeKitDevice {
    onGet() {
      calls += 1;
      return { answer: 42 };
    }
  }
  class MiddleDevice extends BaseDevice {}
  class LeafDevice extends MiddleDevice {}
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-INHERITED'));
  context.after(() => device.remove());

  assert.deepEqual(await device.get({}), { answer: 42 });
  assert.equal(calls, 1);
});

test('prototype traversal resolves parent hooks after awaited child changes', async (context) => {
  let calls = [];
  class BaseDevice extends HomeKitDevice {
    onGet() {
      calls.push('old-base');
    }
  }
  class LeafDevice extends BaseDevice {
    async onGet() {
      calls.push('leaf');
      await setImmediate();
      BaseDevice.prototype.onGet = function () {
        assert.equal(this, device);
        calls.push('new-base');
      };
    }
  }
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-LIVE'));
  context.after(() => device.remove());

  await device.get({});
  assert.deepEqual(calls, ['leaf', 'new-base']);
});

test('generic onMessage fallback retains its scalar result and original arguments', async (context) => {
  class BaseDevice extends HomeKitDevice {
    onMessage(...args) {
      assert.equal(this, device);
      assert.deepEqual(args, ['custom', 'payload', 42]);
      return 'handled';
    }
  }
  class LeafDevice extends BaseDevice {}
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-FALLBACK'));
  context.after(() => device.remove());

  assert.equal(await device.message('custom', 'payload', 42), 'handled');
});

test('prototype traversal deduplicates shared function identities', async (context) => {
  let calls = 0;
  class BaseDevice extends HomeKitDevice {}
  class LeafDevice extends BaseDevice {}
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-SHARED'));
  context.after(() => device.remove());
  let shared = function () {
    assert.equal(this, device);
    calls += 1;
  };
  BaseDevice.prototype.onGet = shared;
  LeafDevice.prototype.onGet = shared;
  device.onGet = shared;

  await device.get({});
  assert.equal(calls, 1);
});

test('registered object handlers traverse prototypes and retain distinct contexts', async (context) => {
  let calls = [];
  class BaseListener {
    onGet() {
      calls.push(this.name + ':base');
    }
  }
  class LeafListener extends BaseListener {
    onGet() {
      calls.push(this.name + ':leaf');
    }
  }
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-LISTENERS'));
  context.after(() => device.remove());
  let first = new LeafListener();
  first.name = 'first';
  let second = new LeafListener();
  second.name = 'second';
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, first);
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, first);
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, second);

  await device.get({});
  assert.deepEqual(calls, ['first:leaf', 'first:base', 'second:leaf', 'second:base']);
});

test('distinct registered closures run once each even when their source text matches', async (context) => {
  let calls = [];
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-CLOSURES'));
  context.after(() => device.remove());
  let hook = (name) => function () {
    assert.equal(this, device);
    calls.push(name);
  };
  let first = hook('first');
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, first);
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, first);
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, hook('second'));

  await device.get({});
  assert.deepEqual(calls, ['first', 'second']);
});

test('hook failures do not prevent parent hooks or registered handlers from running', async (context) => {
  let calls = [];
  let leafError = new Error('Leaf failed');
  class BaseDevice extends HomeKitDevice {
    onGet() {
      calls.push('base');
    }
  }
  class LeafDevice extends BaseDevice {
    async onGet() {
      calls.push('leaf');
      throw leafError;
    }
  }
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-FAILURE'));
  context.after(() => device.remove());
  let warnings = [];
  device.log = { warn: (...args) => warnings.push(args) };
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, () => {
    calls.push('failed-listener');
    throw new Error('Listener failed');
  });
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, () => calls.push('last-listener'));

  await assert.rejects(device.get({}), (error) => error === leafError);
  assert.deepEqual(calls, ['leaf', 'base', 'failed-listener', 'last-listener']);
  assert.equal(warnings.length, 2);
});

test('hook result ordering and registered object precedence remain unchanged', async (context) => {
  class BaseDevice extends HomeKitDevice {
    onGet() {
      return { level: 'base' };
    }
  }
  class LeafDevice extends BaseDevice {
    onGet() {
      return { level: 'leaf' };
    }
  }
  let device = new LeafDevice(undefined, { version: 2.7, hap }, deviceData('CHAIN-RESULTS'));
  context.after(() => device.remove());

  assert.deepEqual(await device.get({}), { 0: { level: 'leaf' }, 1: { level: 'base' } });
  delete BaseDevice.prototype.onGet;
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, () => ({ level: 'registered', extra: true }));
  assert.deepEqual(await device.get({}), { level: 'registered', extra: true });
});

test('GET rejects a registered handler failure even after a successful hook result', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('GET-REJECTION'));
  context.after(() => device.remove());
  let failure = new Error('Read failed');
  let completed = false;
  device.onGet = () => ({ value: 42 });
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, async () => {
    await setImmediate();
    throw failure;
  });
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, () => {
    completed = true;
    return { value: 99 };
  });

  await assert.rejects(HomeKitDevice.message(device.uuid, HomeKitDevice.GET, {}), (error) => error === failure);
  assert.equal(completed, true);
});

test('custom message fallback rejects with its original error', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('CUSTOM-REJECTION'));
  context.after(() => device.remove());
  let failure = new Error('Custom operation failed');
  device.onMessage = async () => {
    await setImmediate();
    throw failure;
  };
  await assert.rejects(device.message('custom', {}), (error) => error === failure);
});

for (let method of ['remove', 'shutdown']) {
  test(method + ' completes cleanup before rejecting a handler failure', async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('CLEANUP-' + method));
    let failure = new Error('Cleanup hook failed');
    let completed = false;
    let uuid = device.uuid;
    context.after(async () => {
      delete device.onRemove;
      delete device.onShutdown;
      await device.remove();
    });
    device.on('probe', () => {});
    device.addTimer('poll', { interval: 10000 }, () => {});
    device[method === 'remove' ? 'onRemove' : 'onShutdown'] = () => {
      throw failure;
    };
    await HomeKitDevice.message(uuid, method === 'remove' ? HomeKitDevice.REMOVE : HomeKitDevice.SHUTDOWN, async () => {
      await setImmediate();
      completed = true;
    });

    await assert.rejects(device[method](), (error) => error === failure);
    assert.equal(completed, true);
    assert.equal(device.hasTimer('poll'), false);
    assert.equal(device.listenerCount('probe'), 0);
    assert.equal(await HomeKitDevice.message(uuid, HomeKitDevice.GET, {}), undefined);
    if (method === 'remove') {
      assert.deepEqual(device.deviceData, {});
      assert.equal(device.uuid, undefined);
    }
  });
}

test('set forwards dispatch failures and waits for asynchronous handlers', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('SET-RESULTS'), requested: false });
  context.after(() => device.remove());
  let originalData = structuredClone(device.deviceData);
  let calls = 0;
  let payload = { requested: true };
  let extra = { source: 'test' };
  let writeError = new Error('Write failed');
  let registeredError = new Error('Registered write failed');
  device.onSet = (values, options) => {
    assert.equal(values, payload);
    assert.equal(options, extra);
    calls += 1;
    throw writeError;
  };
  await assert.rejects(device.set(payload, extra), (error) => error === writeError);
  assert.equal(calls, 1);
  assert.deepEqual(device.deviceData, originalData);

  delete device.onSet;
  await HomeKitDevice.message(device.uuid, HomeKitDevice.SET, async () => {
    await setImmediate();
    calls += 1;
    throw registeredError;
  });
  await assert.rejects(device.set(payload), (error) => error === registeredError);
  assert.equal(calls, 2);
  assert.deepEqual(device.deviceData, originalData);

  // UUID delivery uses the same SET failure guard as the public wrapper.
  await assert.rejects(HomeKitDevice.message(device.uuid, HomeKitDevice.SET, payload), (error) => error === registeredError);
  assert.equal(calls, 3);
  assert.deepEqual(device.deviceData, originalData);

  assert.equal(await device.set(null), undefined);
  assert.equal(calls, 3);
});

test('set preserves the undefined result after a successful asynchronous hook', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, { ...deviceData('SET-SUCCESS'), requested: false });
  context.after(() => device.remove());
  let completed = false;
  device.onSet = async () => {
    await setImmediate();
    completed = true;
  };
  let result = device.set({ requested: true, unknown: 1 });
  assert.equal(device.deviceData.requested, false);
  assert.equal(await result, undefined);
  assert.equal(completed, true);
  assert.equal(device.deviceData.requested, true);
  assert.equal(Object.hasOwn(device.deviceData, 'unknown'), false);
});

test('named hooks and registered handlers preserve scalar results', async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('SCALAR-RESULTS'));
  context.after(() => device.remove());

  for (let value of [42, false, 'ready', undefined]) {
    device.onGet = () => value;
    assert.equal(await device.get({}), value);
    device.onProbe = () => value;
    assert.equal(await device.message('HomeKitDevice.onProbe'), value);
  }

  delete device.onGet;
  let registeredResult = 42;
  await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, () => registeredResult);
  assert.equal(await device.get({}), 42);
  registeredResult = false;
  assert.equal(await device.get({}), false);
});

test('timer message rejection is handled and the one-shot timer is removed', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('TIMER-DISPATCH-REJECTION'));
  context.after(() => device.shutdown());
  let warnings = [];
  let notify;
  let fired = new Promise((resolve) => {
    notify = resolve;
  });
  device.log = { warn: (...args) => warnings.push(args) };
  device.onTimer = async () => {
    notify();
    throw new Error('Timer hook failed');
  };
  device.addTimer('message-poll', { delay: 10 });

  await fired;
  await setImmediate();
  assert.equal(device.hasTimer('message-poll'), false);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings[1], ['Timer callback failed for "%s"', device.deviceData.description]);
});

for (let asynchronous of [false, true]) {
  test('timer logs a ' + (asynchronous === true ? 'rejected' : 'thrown') + ' callback error', { timeout: 1000 }, async (context) => {
    let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('TIMER-LOG-' + asynchronous));
    context.after(() => device.shutdown());
    let warnings = [];
    let notify;
    let fired = new Promise((resolve) => {
      notify = resolve;
    });
    device.log = { warn: (...args) => warnings.push(args) };
    device.addTimer('failed-poll', { delay: 10 }, () => {
      notify();
      let error = new Error('Polling failed');
      if (asynchronous === true) {
        return Promise.reject(error);
      }
      throw error;
    });

    await fired;
    await setImmediate();
    assert.deepEqual(warnings, [['Timer callback failed for "%s"', device.deviceData.description]]);
    assert.equal(device.hasTimer('failed-poll'), false);
  });
}

test('one-shot timers clean up after a synchronous callback failure', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('TIMER-THROW-ONCE'));
  context.after(() => device.shutdown());
  let calls = 0;
  let notify;
  let fired = new Promise((resolve) => {
    notify = resolve;
  });

  device.addTimer('throw-once', { delay: 10 }, () => {
    calls += 1;
    notify();
    throw new Error('Timer callback failed');
  });

  await fired;
  // Let rejection handling and final cleanup finish after the callback throws.
  await setImmediate();

  assert.equal(calls, 1);
  assert.equal(device.hasTimer('throw-once'), false);
});

test('repeating timers continue after a synchronous callback failure', { timeout: 1000 }, async (context) => {
  let device = new HomeKitDevice(undefined, { version: 2.7, hap }, deviceData('TIMER-THROW-REPEAT'));
  context.after(() => device.shutdown());
  let calls = 0;
  let notify;
  let recovered = new Promise((resolve) => {
    notify = resolve;
  });

  device.addTimer('throw-repeat', { interval: 10 }, () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('Timer callback failed');
    }
    notify();
  });

  await recovered;
  await setImmediate();

  assert.equal(calls, 2);
  assert.equal(device.hasTimer('throw-repeat'), true);
});

test('standalone HAP-NodeJS remains HAP-only', async () => {
  let standaloneHap = {
    ...hap,
    HAPLibraryVersion() {
      return '2.0.0';
    },
  };
  let data = {
    ...deviceData('HAP-ONLY'),
    hkUsername: '11:22:33:44:55:66',
    hkPairingCode: '123-45-678',
  };
  let device = new HomeKitDevice(undefined, standaloneHap, data);
  let added = await device.add({
    hapAccessoryName: 'Switch',
    hapCategory: standaloneHap.Categories.SWITCH,
    externalPublish: true,
  });

  assert.equal(device.backend, HomeKitDevice.HAP_NODEJS);
  assert.equal(device.matter, undefined);
  assert.equal(added, true);
  assert.equal(device.accessory.published, true);

  let accessory = device.accessory;
  await device.remove();

  assert.equal(accessory.unpublished, true);
});
