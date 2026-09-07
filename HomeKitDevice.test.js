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
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
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
      this.matterAccessory = {
        UUID: this.uuid,
        displayName: this.deviceData.description,
        deviceType: this.matter.deviceTypes.OnOffSwitch,
        serialNumber: this.deviceData.serialNumber,
        manufacturer: this.deviceData.manufacturer,
        model: this.deviceData.model,
        firmwareRevision: this.deviceData.softwareVersion,
        context: {},
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: () => this.set({ on: true }),
            off: () => this.set({ on: false }),
          },
        },
      };
    }

    async onUpdate(data) {
      await this.matter.updateAccessoryState(this.uuid, this.matter.clusterNames.OnOff, { onOff: data.on === true });
    }
  }

  let device = new MatterSwitch(undefined, api, { ...deviceData('HB-MATTER'), on: false });
  let accessory = await device.add('Switch', hap.Categories.SWITCH);

  assert.equal(device.backend, HomeKitDevice.HOMEBRIDGE);
  assert.equal(device.hap, hap);
  assert.equal(device.matter, api.matter);
  assert.equal(accessory, device.accessory);
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
      this.matterAccessory = {
        UUID: this.uuid,
        displayName: this.deviceData.description,
        deviceType: this.matter.deviceTypes.OnOffSwitch,
        serialNumber: this.deviceData.serialNumber,
        manufacturer: this.deviceData.manufacturer,
        model: this.deviceData.model,
        firmwareRevision: this.deviceData.softwareVersion,
        context: {},
        clusters: { onOff: { onOff: false } },
      };
    }

    async onMessage(type) {
      if (type === HomeKitDevice.ONLINE || type === HomeKitDevice.OFFLINE) {
        this.onlineMessages.push(type);
      }
    }
  }

  let device = new MatterOnlySwitch(undefined, api, { ...deviceData('MATTER-ONLY'), on: false });
  let accessory = await device.add(null);

  assert.equal(device.accessory, undefined);
  assert.equal(accessory, device.matterAccessory);
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
  let accessory = await device.add();

  assert.equal(accessory, device.accessory);
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.shutdown, 1);

  await device.update({ description: 'Renamed HAP accessory' });

  assert.equal(accessory.displayName, 'Renamed HAP accessory');
  assert.equal(calls.updated.length, 1);

  await device.remove();

  assert.equal(calls.unregistered.length, 1);
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
      this.matterAccessory = {
        UUID: this.uuid,
        displayName: this.deviceData.description,
        deviceType: this.matter.deviceTypes.OnOffSwitch,
        serialNumber: this.deviceData.serialNumber,
        manufacturer: this.deviceData.manufacturer,
        model: this.deviceData.model,
        context: {},
        clusters: { onOff: { onOff: false } },
      };
    }
  }

  let device = new OptionalMatterSwitch(undefined, api, deviceData('HAP-FALLBACK'));
  let accessory = await device.add('Switch');

  assert.equal(accessory, device.accessory);
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

  class UnavailableMatterSwitch extends HomeKitDevice {
    async onAdd() {
      this.matterAccessory = {
        UUID: this.uuid,
        displayName: this.deviceData.description,
        deviceType: {},
        serialNumber: this.deviceData.serialNumber,
        manufacturer: this.deviceData.manufacturer,
        model: this.deviceData.model,
        context: {},
      };
    }
  }

  let device = new UnavailableMatterSwitch(undefined, api, deviceData('MATTER-UNAVAILABLE'));

  assert.equal(await device.add(null), undefined);
  assert.equal(device.accessory, undefined);
  assert.equal(device.matterAccessory, undefined);

  await device.remove();
});

test('Homebridge rolls back a newly registered HAP accessory when setup fails', async () => {
  let calls = { registered: 0, unregistered: 0 };
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

  let device = new BrokenHapSwitch(undefined, api, deviceData('HAP-ROLLBACK'));

  assert.equal(await device.add(), undefined);
  assert.equal(device.accessory, undefined);
  assert.equal(calls.registered, 1);
  assert.equal(calls.unregistered, 1);

  await device.remove();
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
  let accessory = await device.add('Switch', standaloneHap.Categories.SWITCH);

  assert.equal(device.backend, HomeKitDevice.HAP_NODEJS);
  assert.equal(device.matter, undefined);
  assert.equal(accessory.published, true);

  await device.remove();

  assert.equal(accessory.unpublished, true);
});
