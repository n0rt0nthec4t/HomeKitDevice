import assert from 'node:assert/strict';
import test from 'node:test';

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
      return `uuid:${value}`;
    },
  },
};

const deviceData = (serialNumber) => ({
  serialNumber,
  softwareVersion: '1.0.0',
  description: `Device ${serialNumber}`,
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

test('Homebridge exposes HAP and Matter through the existing lifecycle', async () => {
  let calls = {
    hapRegistered: [],
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
    },
    unregisterPlatformAccessories(plugin, platform, accessories) {
      calls.hapUnregistered.push({ plugin, platform, accessories });
    },
    updatePlatformAccessories() {},
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

  let device = new MatterSwitch(undefined, api, { ...deviceData('HB-MATTER'), on: false });
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
  assert.equal(calls.matterRegistered.length, 1);
  assert.equal(calls.matterInformationUpdated.length, 0);
  assert.equal(calls.matterRegistered[0].accessories[0], device.matterAccessory);
  assert.deepEqual(calls.matterUpdated.at(-1).attributes, { onOff: false });

  await device.remove();

  assert.equal(calls.hapUnregistered.length, 1);
  assert.equal(calls.matterUnregistered.length, 1);
  assert.equal(device.accessory, undefined);
  assert.equal(device.matterAccessory, undefined);
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

  class BrokenHapSwitch extends HomeKitDevice {
    async onAdd() {
      throw new Error('Setup failed');
    }
  }

  let device = new BrokenHapSwitch(cachedHapAccessory, api, deviceData('HAP-ROLLBACK'));

  assert.equal(await device.add(), undefined);
  assert.equal(device.accessory, cachedHapAccessory);
  assert.equal(calls.registered, 0);
  assert.equal(calls.unregistered, 0);

  await device.remove();
  assert.equal(calls.unregistered, 1);
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
  let added = await device.add({ hapAccessoryName: 'Switch', hapCategory: standaloneHap.Categories.SWITCH });

  assert.equal(device.backend, HomeKitDevice.HAP_NODEJS);
  assert.equal(device.matter, undefined);
  assert.equal(added, true);
  assert.equal(device.accessory.published, true);

  let accessory = device.accessory;
  await device.remove();

  assert.equal(accessory.unpublished, true);
});
