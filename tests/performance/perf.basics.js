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
    {
      name: 'pull-replication-perf-with-multiple-revisions',
      assertions: 1,
      iterations: 1,
      setup: function (localDB, callback) {
        // These are the key nobs to twiddle with to experiment
        // with perf.
        var remoteDBOpts = {ajax: {pool: {maxSockets: 15}}},
          numberDocs = 1000,
          addedLatencyInMs = 100,
          batchSize = 100;

        function setUpReverseProxy(remoteCouchUrl) {
          var http = require('http'),
            httpProxy = require('http-proxy'),
            parsedRemoteCouchUrl = url.parse(remoteCouchUrl),
            proxy = httpProxy.createProxyServer(),
            proxyServer = http.createServer(function (req, res) {
              setTimeout(function () {
                proxy.web(req, res, {
                  target: "http://" + parsedRemoteCouchUrl.host
                });
              }, addedLatencyInMs);
            }).listen(commonUtils.portForThrottleReverseProxy),
            serverProxyUrl = url.parse(remoteCouchUrl);

          // When parsing a URL object url.format honors host before
          // hostname + port, so we have to set host.
          serverProxyUrl.host = parsedRemoteCouchUrl.hostname + ":" +
            commonUtils.portForThrottleReverseProxy;

          var proxiedRemoteDB =
            new PouchDB(url.format(serverProxyUrl), remoteDBOpts);

          return {proxiedRemoteDB: proxiedRemoteDB,
            proxyServer: proxyServer};
        }

        var remoteCouchUrl =
              commonUtils.couchHost() + "/" +
              commonUtils.safeRandomDBName(),
            remoteDB =
              new PouchDB(remoteCouchUrl, remoteDBOpts),
            docs = [],
            localPouches = [],
            i,
            proxyConfig = setUpReverseProxy(remoteCouchUrl),
            localOpts = {ajax: {timeout: 60 * 1000}};

        for (i = 0; i < this.iterations; ++i) {
          localPouches[i] = new PouchDB(commonUtils.safeRandomDBName());
        }

        for (i = 0; i < numberDocs; i++) {
          docs.push({_id: createDocId(i),
                     foo: Math.random(),
                     bar: Math.random()});
        }

        remoteDB.bulkDocs({docs: docs}, localOpts).then(function () {
          return Promise.all(docs.map(function (doc) {
            return remoteDB.get(doc._id, localOpts).then(function (gotDoc) {
              gotDoc.foo = Math.random();
              gotDoc.bar = Math.random();
              return remoteDB.put(gotDoc, localOpts);
            });
          }));
        }).then(function () {
          return callback(null,
            { localPouches: localPouches, remoteDB: remoteDB,
              proxyServer: proxyConfig.proxyServer,
              proxiedRemoteDB: proxyConfig.proxiedRemoteDB,
              batchSize: batchSize});
        }).error(function (e) {
          console.log("error - " + e);
        });
      },
      test: function (ignoreDB, itr, testContext, done) {
        var localDB = testContext.localPouches[itr],
            remoteDB = testContext.proxiedRemoteDB;

        PouchDB.replicate(remoteDB, localDB,
          {live: false, batch_size: testContext.batchSize})
          .on('change', function (info) {})
          .on('complete', function () { done(); })
          .on('error', done);
      },
      tearDown: function (ignoreDB, testContext) {
        return Promise.promisifyAll(testContext.proxyServer)
          .closeAsync()
        .then(function () {
          return testContext.remoteDB.destroy();
        }).then(function () {
          return Promise.all(
            testContext.localPouches.map(function (localPouch) {
              return localPouch.destroy();
            }));
        });
      }
    },
    {
      name: 'pull-replication-perf-skimdb',
      assertions: 1,
      iterations: 0,
      setup: function (localDB, callback) {
          var remoteCouchUrl = "http://skimdb.iriscouch.com/registry",
              remoteDB = new PouchDB(remoteCouchUrl,
                  {ajax: {pool: {maxSockets: 15}}}),
              localPouches = [],
              i;

          for (i = 0; i < this.iterations; ++i) {
            localPouches[i] = new PouchDB(commonUtils.safeRandomDBName());
          }

          return callback(null,
              { localPouches: localPouches, remoteDB: remoteDB});
        },
      test: function (ignoreDB, itr, testContext, done) {
          var localDB = testContext.localPouches[itr],
              remoteDB = testContext.remoteDB;

          var replication = PouchDB.replicate(remoteDB, localDB,
              {live: false, batch_size: 100})
              .on('change', function (info) {
                  if (info.docs_written >= 200) {
                    replication.cancel();
                    done();
                  }
                })
              .on('error', done);
        },
      tearDown: function (ignoreDB, testContext) {
          if (testContext && testContext.localPouches) {
            return Promise.all(
                testContext.localPouches.map(function (localPouch) {
                    return localPouch.destroy();
                  }));
          }
        }
    }
  ];

  utils.runTests(PouchDB, 'basics', testCases, opts);
};