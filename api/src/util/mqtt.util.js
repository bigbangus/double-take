const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const mqtt = require('mqtt');
const fs = require('fs');
const { contains } = require('./helpers.util');
const { jwt } = require('./auth.util');
const { AUTH, SERVER, MQTT, FRIGATE, CAMERAS, STORAGE } = require('../constants');

let PREVIOUS_MQTT_LENGTHS = [];
let JUST_SUBSCRIBED = false;
let CLIENT = false;
const PERSON_RESET_TIMEOUT = {};

const cameraTopics = () => {
  return CAMERAS
    ? Object.keys(CAMERAS)
        .filter((key) => CAMERAS[key].SNAPSHOT && CAMERAS[key].SNAPSHOT.TOPIC)
        .map((key) => {
          return CAMERAS[key].SNAPSHOT.TOPIC;
        })
    : [];
};

const processMessage = ({ topic, message }) => {
  const init = async () => {
    if ((topic.includes('/snapshot') || cameraTopics().includes(topic)) && !JUST_SUBSCRIBED)
      await processMessage({ topic, message }).snapshot();
    if (topic.includes('/events')) await processMessage({ topic, message }).frigate();
  };

  const snapshot = async () => {
    const camera = topic.split('/')[1];
    const filename = `${uuidv4()}.jpg`;
    const buffer = Buffer.from(message);

    if (PREVIOUS_MQTT_LENGTHS.includes(buffer.length)) {
      return;
    }
    PREVIOUS_MQTT_LENGTHS.unshift(buffer.length);

    fs.writeFileSync(`${STORAGE.TMP.PATH}/${filename}`, buffer);
    await axios({
      method: 'get',
      url: `http://0.0.0.0:${SERVER.PORT}/api/recognize`,
      headers: AUTH ? { authorization: jwt.sign({ route: 'recognize' }) } : null,
      params: {
        url: `http://0.0.0.0:${SERVER.PORT}/api/${STORAGE.TMP.PATH}/${filename}`,
        type: 'mqtt',
        camera,
      },
      validateStatus: () => true,
    });
    // only store last 10 mqtt lengths
    PREVIOUS_MQTT_LENGTHS = PREVIOUS_MQTT_LENGTHS.slice(0, 10);
  };

  const frigate = async () => {
    const payload = JSON.parse(message.toString());
    if (payload.type === 'end') return;

    await axios({
      method: 'post',
      url: `http://0.0.0.0:${SERVER.PORT}/api/recognize`,
      headers: AUTH ? { authorization: jwt.sign({ route: 'recognize' }) } : null,
      data: {
        ...payload,
        topic,
      },
      validateStatus: () => true,
    });
  };

  return { init, snapshot, frigate };
};

module.exports.connect = () => {
  if (!MQTT.HOST) {
    return;
  }
  CLIENT = mqtt.connect(`mqtt://${MQTT.HOST}`, {
    reconnectPeriod: 10000,
    username: MQTT.USERNAME,
    password: MQTT.PASSWORD,
  });

  CLIENT.on('connect', () => {
    console.log('MQTT: connected');
    this.publish({ topic: 'double-take/errors' });
    this.available('online');
    this.subscribe();
  })
    .on('error', (err) => console.error(`MQTT: ${err.code}`))
    .on('offline', () => console.error('MQTT: offline'))
    .on('disconnect', () => console.error('MQTT: disconnected'))
    .on('reconnect', () => console.warn('MQTT: attempting to reconnect'))
    .on('message', async (topic, message) => processMessage({ topic, message }).init());
};

module.exports.available = async (state) => {
  if (CLIENT) this.publish({ topic: 'double-take/available', message: state });
};

module.exports.subscribe = () => {
  const topics = [];

  topics.push(...cameraTopics());

  if (FRIGATE.URL && MQTT.TOPICS.FRIGATE) {
    const isArray = Array.isArray(MQTT.TOPICS.FRIGATE);

    const frigateTopics = isArray ? MQTT.TOPICS.FRIGATE : [MQTT.TOPICS.FRIGATE];
    topics.push(...frigateTopics);
    frigateTopics.forEach((topic) => {
      const [prefix] = topic.split('/');
      topics.push(
        ...(FRIGATE.CAMERAS
          ? FRIGATE.CAMERAS.map((camera) => `${prefix}/${camera}/person/snapshot`)
          : [`${prefix}/+/person/snapshot`])
      );
    });
  }

  if (topics.length) {
    CLIENT.subscribe(topics, (err) => {
      if (err) {
        console.error(`MQTT: error subscribing to ${topics.join(', ')}`);
        return;
      }
      console.log(`MQTT: subscribed to ${topics.join(', ')}`);
      JUST_SUBSCRIBED = true;
      setTimeout(() => (JUST_SUBSCRIBED = false), 5000);
    });
  }
};

module.exports.recognize = (data) => {
  try {
    if (!MQTT || !MQTT.HOST) return;
    const { matches, unknown, camera } = data;
    const hasUnknown = unknown && Object.keys(unknown).length;

    const configData = JSON.parse(JSON.stringify(data));
    delete configData.matches;
    delete configData.unknown;
    delete configData.results;

    const messages = [];

    let personCount = matches.length ? matches.length : hasUnknown ? 1 : 0;
    // check to see if unknown bounding box is contained within or contains any of the match bounding boxes
    // if false, then add 1 to the person count
    if (matches.length && hasUnknown) {
      let unknownContained = false;
      matches.forEach((match) => {
        if (contains(match.box, unknown.box) || contains(unknown.box, match.box))
          unknownContained = true;
      });
      if (!unknownContained) personCount += 1;
    }

    messages.push({
      topic: `${MQTT.TOPICS.CAMERAS}/${camera}/person`,
      message: personCount.toString(),
    });

    if (hasUnknown) {
      messages.push({
        topic: `${MQTT.TOPICS.MATCHES}/unknown`,
        message: JSON.stringify({
          ...configData,
          unknown,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/unknown/config`,
          message: JSON.stringify({
            name: 'double_take_unknown',
            icon: 'mdi:account',
            value_template: '{{ value_json.camera }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/unknown/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/unknown/state`,
            availability_topic: 'double-take/available',
            unique_id: `double_take_unknown`,
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/unknown/state`,
          message: JSON.stringify({
            ...configData,
            unknown,
          }),
        });
      }
    }

    matches.forEach((match) => {
      const topic = match.name.replace(/\s+/g, '-');
      const name = match.name.replace(/\s+/g, '_');

      messages.push({
        topic: `${MQTT.TOPICS.MATCHES}/${topic}`,
        message: JSON.stringify({
          ...configData,
          match,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${topic}/config`,
          message: JSON.stringify({
            name: `double_take_${name}`,
            icon: 'mdi:account',
            value_template: '{{ value_json.camera }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${topic}/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${topic}/state`,
            availability_topic: 'double-take/available',
            unique_id: `double_take_${name}`,
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${topic}/state`,
          message: JSON.stringify({
            ...configData,
            match,
          }),
        });
      }
    });

    if (matches.length || hasUnknown) {
      messages.push({
        topic: `${MQTT.TOPICS.CAMERAS}/${camera}`,
        message: JSON.stringify({
          ...configData,
          matches,
          unknown,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${camera}/config`,
          message: JSON.stringify({
            name: `double_take_${camera}`,
            icon: 'mdi:camera',
            value_template: '{{ value_json.personCount }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${camera}/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${camera}/state`,
            availability_topic: 'double-take/available',
            unique_id: `double_take_${camera}`,
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${camera}/state`,
          message: JSON.stringify({
            ...configData,
            matches,
            unknown,
            personCount,
          }),
        });
      }
    }

    this.publish(messages);

    clearTimeout(PERSON_RESET_TIMEOUT[camera]);
    PERSON_RESET_TIMEOUT[camera] = setTimeout(() => {
      this.publish({ topic: `${MQTT.TOPICS.CAMERAS}/${camera}/person`, message: '0' });
      if (MQTT.TOPICS.HOMEASSISTANT) {
        this.publish({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/double-take/${camera}/state`,
          message: JSON.stringify({
            ...configData,
            matches,
            unknown,
            personCount: 0,
          }),
        });
      }
    }, 30000);
  } catch (error) {
    error.message = `MQTT: recognize error: ${error.message}`;
    console.error(error);
  }
};

module.exports.publish = (data) => {
  if (!CLIENT) return;
  const multiple = Array.isArray(data);
  const single = data && !multiple && typeof data === 'object';

  if (!single && !multiple) console.error('MQTT: publish error');

  const messages = single ? [{ ...data }] : data;
  messages.forEach((message) => CLIENT.publish(message.topic, message.message, { retain: true }));
};
