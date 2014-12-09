'use strict';

module.exports = function (PouchDB, opts) {

  // need to use bluebird for promises everywhere, so we're comparing
  // apples to apples
  var Promise = require('bluebird'),
      utils = require('./utils'),
      url = require('url'),
      commonUtils = require('../common-utils.js');

  function createDocId(i) {
    var intString = i.toString();
    while (intString.length < 10) {
      intString = '0' + intString;
    }
    return 'doc_' + intString;
  }

  /**
   * @typedef {Object} PullRequestTestObjectConfig
   * @property {string} name - Name to display for the test
   * @property {number} iterations - How many times to run the test
   * @property {number} generations - How many generations should each
   * doc have? Value must be at least 1.
   * @property {number} numberDocs - How many docs to generate for the test
   * @property {number} batchSize - How many docs to process during replication
   * per batch
   * @property {number} addedLatencyInMs - Latency to add to each GET request
   * in milliseconds to simulate network latency
   * @property {number} maxSockets - How many sockets to try and use during
   * replication (only relevant ot node.js)
   */

  /* jshint ignore:start */
  /**
   * Creates the test object for pull replication
   * @param {PullRequestTestObjectConfig} config
   * @returns {{name: {string}, assertions: {number}, iterations: {number}, setup: *, test: *, tearDown: *}}
   * @constructor
   */
  /* jshint ignore:end */
  var PullRequestTestObject = function (config) {
    if (config.generations <= 0) {
      throw new Error("generations must be > 0");
    }

    this.generations = config.generations;
    this.numberDocs = config.numberDocs;
    this.batchSize = config.batchSize;
    this.maxSockets = config.maxSockets;
    this.iterations = config.iterations;
    this.addedLatencyInMs = config.addedLatencyInMs;
    this.localPouches = [];

    return {
      name: config.name,
      assertions: 1,
      iterations: this.iterations,
      setup: this.setup(),
      test: this.test(),
      tearDown: this.tearDown()
    };
  };

  PullRequestTestObject.prototype.setup = function () {
    var self = this;
    return function (localDB, callback) {
      var remoteDBOpts = {ajax: {pool: {maxSockets: self.maxSockets}}},
        remoteCouchUrl =
          commonUtils.couchHost() + "/" +
          commonUtils.safeRandomDBName();
      self.remoteDB = new PouchDB(remoteCouchUrl, remoteDBOpts);

      // Set up reverse proxy server
      var http = require('http'),
        httpProxy = require('http-proxy'),
        parsedRemoteCouchUrl = url.parse(remoteCouchUrl),
        proxy = httpProxy.createProxyServer(),
        serverProxyUrl = url.parse(remoteCouchUrl);

      self.proxyServer = http.createServer(function (req, res) {
        setTimeout(function () {
          proxy.web(req, res, {
            target: "http://" + parsedRemoteCouchUrl.host
          });
        }, self.addedLatencyInMs);
      }).listen(commonUtils.portForThrottleReverseProxy);

      // When parsing a URL object url.format honors host before
      // hostname + port, so we have to set host.
      serverProxyUrl.host = parsedRemoteCouchUrl.hostname + ":" +
      commonUtils.portForThrottleReverseProxy;

      self.proxiedRemoteDB =
        new PouchDB(url.format(serverProxyUrl), remoteDBOpts);

      var docs = [],
        i,
        localOpts = {ajax: {timeout: 60 * 1000}};

      for (i = 0; i < self.iterations; ++i) {
        self.localPouches[i] = new PouchDB(commonUtils.safeRandomDBName());
      }

      for (i = 0; i < self.numberDocs; i++) {
        docs.push(
          {
            _id: createDocId(i),
            foo: Math.random(),
            bar: Math.random()
          });
      }

      var addGeneration = function (generationCount, docs) {
        return self.remoteDB.bulkDocs({docs: docs}, localOpts)
          .then(function (bulkDocsResponse) {
            --generationCount;
            if (generationCount <= 0) {
              return {};
            }
            var updatedDocs = bulkDocsResponse.map(function (doc) {
              return {
                _id: doc.id,
                _rev: doc.rev,
                foo: Math.random(),
                bar: Math.random()
              };
            });
            return addGeneration(generationCount, updatedDocs);
          });
      };

      return addGeneration(self.generations, docs).then(callback);
    };
  };

  PullRequestTestObject.prototype.test = function () {
    var self = this;
    return function (ignoreDB, itr, ignoreContext, done) {
      var localDB = self.localPouches[itr],
        remoteDB = self.proxiedRemoteDB;

      PouchDB.replicate(remoteDB, localDB,
        {live: false, batch_size: self.batchSize})
      .on('change', function (info) {
        //console.log("info - " + info);
      })
      .on('complete', function (info) {
        //console.log("complete - " + info);
        done();
      })
      .on('error', function (err) {
        //console.log("error - " + err);
      });
    };
  };

  PullRequestTestObject.prototype.tearDown = function () {
    var self = this;
    return function (ignoreDB, ignoreContext) {
      return Promise.promisifyAll(self.proxyServer)
        .closeAsync()
        .then(function () {
          return self.remoteDB.destroy();
        }).then(function () {
          return Promise.all(
            self.localPouches.map(function (localPouch) {
              return localPouch.destroy();
            }));
        });
    };
  };

  var testCases = [
    //{
    //  name: 'basic-inserts',
    //  assertions: 1,
    //  iterations: 1000,
    //  setup: function (db, callback) {
    //    callback(null, {'yo': 'dawg'});
    //  },
    //  test: function (db, itr, doc, done) {
    //    db.post(doc, done);
    //  }
    //}, {
    //  name: 'bulk-inserts',
    //  assertions: 1,
    //  iterations: 100,
    //  setup: function (db, callback) {
    //    var docs = [];
    //    for (var i = 0; i < 100; i++) {
    //      docs.push({much : 'docs', very : 'bulk'});
    //    }
    //    callback(null, {docs : docs});
    //  },
    //  test: function (db, itr, docs, done) {
    //    db.bulkDocs(docs, done);
    //  }
    //}, {
    //  name: 'basic-gets',
    //  assertions: 1,
    //  iterations: 10000,
    //  setup: function (db, callback) {
    //    var docs = [];
    //    for (var i = 0; i < 10000; i++) {
    //      docs.push({_id : createDocId(i), foo : 'bar', baz : 'quux'});
    //    }
    //    db.bulkDocs({docs : docs}, callback);
    //  },
    //  test: function (db, itr, docs, done) {
    //    db.get(createDocId(itr), done);
    //  }
    //}, {
    //  name: 'all-docs-skip-limit',
    //  assertions: 1,
    //  iterations: 50,
    //  setup: function (db, callback) {
    //    var docs = [];
    //    for (var i = 0; i < 1000; i++) {
    //      docs.push({_id : createDocId(i), foo : 'bar', baz : 'quux'});
    //    }
    //    db.bulkDocs({docs : docs}, callback);
    //  },
    //  test: function (db, itr, docs, done) {
    //    var tasks = [];
    //    for (var i = 0; i < 10; i++) {
    //      tasks.push(i);
    //    }
    //    Promise.all(tasks.map(function (doc, i) {
    //      return db.allDocs({skip : i * 100, limit : 10});
    //    })).then(function () {
    //      done();
    //    }, done);
    //  }
    //}, {
    //  name: 'all-docs-startkey-endkey',
    //  assertions: 1,
    //  iterations: 50,
    //  setup: function (db, callback) {
    //    var docs = [];
    //    for (var i = 0; i < 1000; i++) {
    //      docs.push({_id: createDocId(i), foo: 'bar', baz: 'quux'});
    //    }
    //    db.bulkDocs({docs: docs}, callback);
    //  },
    //  test: function (db, itr, docs, done) {
    //    var tasks = [];
    //    for (var i = 0; i < 10; i++) {
    //      tasks.push(i);
    //    }
    //    Promise.all(tasks.map(function (doc, i) {
    //      return db.allDocs({
    //        startkey: createDocId(i * 100),
    //        endkey: createDocId((i * 100) + 10)
    //      });
    //    })).then(function () {
    //      done();
    //    }, done);
    //  }
    //},
    //{
    //  name: 'pull-replication-perf-testing',
    //  assertions: 1,
    //  iterations: 1,
    //  pullReplicationTestHarness:
    //}
  ];

  testCases.push(new PullRequestTestObject({
    name: "pull-replicationperf-one-generation",
    iterations: 1,
    generations: 1,
    numberDocs: 10,
    batchSize: 100,
    addedLatencyInMs: 10,
    maxSockets: 15
  }));

  testCases.push(new PullRequestTestObject({
    name: "pull-replicationperf-two-generations",
    iterations: 1,
    generations: 2,
    numberDocs: 10,
    batchSize: 100,
    addedLatencyInMs: 10,
    maxSockets: 15
  }));
  //  {
  //    name: 'pull-replication-perf-one-generation',
  //    assertions: 1,
  //    iterations: 1,
  //    createPullRequestTest: new PullRequestTestObject(1, 1000, 10, 100, 15),
  //    setup: (function () { return this.createPullRequestTest.setup; }()),
  //    test: this.createPullRequestTest.test,
  //    tearDown: this.createPullRequestTest.tearDown
  //  },
  //  {
  //    name: 'pull-replication-perf-with-multiple-revisions',
  //    assertions: 1,
  //    iterations: 1,
  //    createPullRequestTest: new PullRequestTestObject(1, 1000, 10, 100, 15),
  //    setup: function (localDB, callback) {
  //      // These are the key nobs to twiddle with to experiment
  //      // with perf.
  //      var remoteDBOpts = {ajax: {pool: {maxSockets: 15}}},
  //        numberDocs = 1000,
  //        addedLatencyInMs = 100,
  //        batchSize = 100;
  //
  //      function setUpReverseProxy(remoteCouchUrl) {
  //        var http = require('http'),
  //          httpProxy = require('http-proxy'),
  //          parsedRemoteCouchUrl = url.parse(remoteCouchUrl),
  //          proxy = httpProxy.createProxyServer(),
  //          proxyServer = http.createServer(function (req, res) {
  //            setTimeout(function () {
  //              proxy.web(req, res, {
  //                target: "http://" + parsedRemoteCouchUrl.host
  //              });
  //            }, addedLatencyInMs);
  //          }).listen(commonUtils.portForThrottleReverseProxy),
  //          serverProxyUrl = url.parse(remoteCouchUrl);
  //
  //        // When parsing a URL object url.format honors host before
  //        // hostname + port, so we have to set host.
  //        serverProxyUrl.host = parsedRemoteCouchUrl.hostname + ":" +
  //          commonUtils.portForThrottleReverseProxy;
  //
  //        var proxiedRemoteDB =
  //          new PouchDB(url.format(serverProxyUrl), remoteDBOpts);
  //
  //        return {proxiedRemoteDB: proxiedRemoteDB,
  //          proxyServer: proxyServer};
  //      }
  //
  //      var remoteCouchUrl =
  //            commonUtils.couchHost() + "/" +
  //            commonUtils.safeRandomDBName(),
  //          remoteDB =
  //            new PouchDB(remoteCouchUrl, remoteDBOpts),
  //          docs = [],
  //          localPouches = [],
  //          i,
  //          proxyConfig = setUpReverseProxy(remoteCouchUrl),
  //          localOpts = {ajax: {timeout: 60 * 1000}};
  //
  //      for (i = 0; i < this.iterations; ++i) {
  //        localPouches[i] = new PouchDB(commonUtils.safeRandomDBName());
  //      }
  //
  //      for (i = 0; i < numberDocs; i++) {
  //        docs.push({_id: createDocId(i),
  //                   foo: Math.random(),
  //                   bar: Math.random()});
  //      }
  //
  //      remoteDB.bulkDocs({docs: docs}, localOpts).then(function () {
  //        return Promise.all(docs.map(function (doc) {
  //          return remoteDB.get(doc._id, localOpts).then(function (gotDoc) {
  //            gotDoc.foo = Math.random();
  //            gotDoc.bar = Math.random();
  //            return remoteDB.put(gotDoc, localOpts);
  //          });
  //        }));
  //      }).then(function () {
  //        return callback(null,
  //          { localPouches: localPouches, remoteDB: remoteDB,
  //            proxyServer: proxyConfig.proxyServer,
  //            proxiedRemoteDB: proxyConfig.proxiedRemoteDB,
  //            batchSize: batchSize});
  //      }).error(function (e) {
  //        console.log("error - " + e);
  //      });
  //    },
  //    test: function (ignoreDB, itr, testContext, done) {
  //      var localDB = testContext.localPouches[itr],
  //          remoteDB = testContext.proxiedRemoteDB;
  //
  //      PouchDB.replicate(remoteDB, localDB,
  //        {live: false, batch_size: testContext.batchSize})
  //        .on('change', function (info) {})
  //        .on('complete', function () { done(); })
  //        .on('error', done);
  //    },
  //    tearDown: function (ignoreDB, testContext) {
  //      return Promise.promisifyAll(testContext.proxyServer)
  //        .closeAsync()
  //      .then(function () {
  //        return testContext.remoteDB.destroy();
  //      }).then(function () {
  //        return Promise.all(
  //          testContext.localPouches.map(function (localPouch) {
  //            return localPouch.destroy();
  //          }));
  //      });
  //    }
  //  },
  //  {
  //    name: 'pull-replication-perf-skimdb',
  //    assertions: 1,
  //    iterations: 0,
  //    setup: function (localDB, callback) {
  //        var remoteCouchUrl = "http://skimdb.iriscouch.com/registry",
  //            remoteDB = new PouchDB(remoteCouchUrl,
  //                {ajax: {pool: {maxSockets: 15}}}),
  //            localPouches = [],
  //            i;
  //
  //        for (i = 0; i < this.iterations; ++i) {
  //          localPouches[i] = new PouchDB(commonUtils.safeRandomDBName());
  //        }
  //
  //        return callback(null,
  //            { localPouches: localPouches, remoteDB: remoteDB});
  //      },
  //    test: function (ignoreDB, itr, testContext, done) {
  //        var localDB = testContext.localPouches[itr],
  //            remoteDB = testContext.remoteDB;
  //
  //        var replication = PouchDB.replicate(remoteDB, localDB,
  //            {live: false, batch_size: 100})
  //            .on('change', function (info) {
  //                if (info.docs_written >= 200) {
  //                  replication.cancel();
  //                  done();
  //                }
  //              })
  //            .on('error', done);
  //      },
  //    tearDown: function (ignoreDB, testContext) {
  //        if (testContext && testContext.localPouches) {
  //          return Promise.all(
  //              testContext.localPouches.map(function (localPouch) {
  //                  return localPouch.destroy();
  //                }));
  //        }
  //      }
  //  }
  //];

  utils.runTests(PouchDB, 'basics', testCases, opts);
};