

/*
 * CONSTANTS
 */
var shareRegExp = /\\\\([^\\]*)\\([^\\]*)\\?/
  , port = 445
  ;


/*
 * DEPENDENCIES
 */
var net = require('net')
  , bigint = require('./tools/bigint')
  , SMB2Message = require('./message')
  , fs = require('fs')
  ;


/*
 * CONSTRUCTOR
 */
var SMB = module.exports = function(opt){

  opt = opt || {};

  // Parse share-string
  var matches;
  if(!opt.share || !(matches = opt.share.match(shareRegExp))){
    throw new Error('the share is not valid');
  }

  // resolve IP from NetBios
  // this.ip = netBios.resolve(matches[0]);
  this.ip = matches[1];

  // extract share
  this.share = matches[2];

  // save the full path
  this.fullPath = opt.share;

  // packet concurrency
  this.packetConcurrency = opt.packetConcurrency || 20;

  // store authentification
  this.domain   = opt.domain;
  this.username = opt.username;
  this.password = opt.password;

  // set session id
  this.SessionId = 0;

  // create a socket
  this.socket = new net.Socket({
    allowHalfOpen:true
  });

  // attach data events to socket
  this.socket.on('data', parseResponse(this));
  var connection = this;
  this.socket.on('error', function(){
    if(connection.debug){
      console.log('-- error');
      console.log(arguments);
    }
  });

};


/*
 * PROTOTYPE
 */
var proto = SMB.prototype = {};



/*
 * connect
 * =======
 *
 * connect you to the SMB2 server:
 *
 *  - open TCP socket
 *
 *  - negotiation SM2 connection
 *
 *  - setup session / ntlm negotiatiation
 *
 *  - setup session / ntlm authetication
 *
 *  - tree connect
 *
 */
proto.connect = function(cb){
  var connection = this;

  // open TCP socket
  connection.socket.connect(port, this.ip);

  // SMB2 negotiate connection
  SMB2Request('negotiate', {}, connection, function(err){
    if(err) cb && cb(err);
    // SMB2 setup session / negotiate ntlm
    else SMB2Request('session_setup_step1', {}, connection, function(err){
      if(err) cb && cb(err);
      // SMB2 setup session / autheticate with ntlm
      else SMB2Request('session_setup_step2', {}, connection, function(err){
        if(err) cb && cb(err);
        // SMB2 tree connect
        else SMB2Request('tree_connect', {}, connection, function(err){
          if(err) cb && cb(err);
          else cb && cb(null);
        });
      });
    });
  });
}


/*
 * close
 * =====
 *
 * close your connection to the SMB2 server
 *
 *  - close TCP connection
 *
 */
proto.close = function(){
  this.socket.end();
}


/*
 * readDir
 * =======
 *
 * list the file / directory from the path provided:
 *
 *  - open the directory
 *
 *  - query directory content
 *
 *  - close the directory
 *
 */
proto.readDir = function(path, cb){
  var connection = this;

  // SMB2 open directory
  SMB2Request('open', {path:path}, connection, function(err, file){
    if(err) cb && cb(err);
    // SMB2 query directory
    else SMB2Request('query_directory', file, connection, function(err, files){
      if(err) cb && cb(err);
      // SMB2 close directory
      else SMB2Request('close', file, connection, function(err){
        cb && cb(err, files);
      });
    });
  });
}


/*
 * readFile
 * ========
 *
 * read the content of a file from the share
 *
 *  - open the file
 *
 *  - read the content
 *
 *  - close the file
 *
 */
proto.readFile = function(path, cb){
  var connection = this;

  // SMB2 open file
  SMB2Request('open', {path:dest}, connection, function(err, file){
    if(err) cb && cb(err);
    // SMB2 read file content
    else {
      var fileLength = 0
        , offset = new bigint(8)
        , stop = false
        , nbRemainingPackets = 0
        , maxPacketSize = 0x00010000
        ;
      // get file length
      for(var i=0;i<file.EndofFile.length;i++){
        fileLength |= file.EndofFile[i] << (i*8);
      }
      var result = new Buffer(fileLength);
      // callback manager
      function callback(offset){
        return function(err, content){
          if(stop) return;
          if(err) {
            cb && cb(err);
            stop = true;
          } else {
            content.copy(result, offset.toNumber());
            nbRemainingPackets--;
            checkDone();
          }
        }
      }
      // callback manager
      function checkDone(){
        if(stop) return;
        createPackets();
        if(nbRemainingPackets==0 && offset.ge(fileLength)) {
          SMB2Request('close', file, connection, function(err){
            cb && cb(err, result);
          })
        }
      }
      // create packets
      function createPackets(){
        while(nbRemainingPackets<connection.packetConcurrency && offset.lt(fileLength)){
          // process packet size
          var rest = offset.sub(fileLength).neg();
          var packetSize = rest.gt(maxPacketSize) ? maxPacketSize : rest.toNumber();
          // generate buffer
          SMB2Request('read', {
            'FileId':file.FileId
          , 'Length':packetSize
          , 'Offset':offset.toBuffer()
          }, connection, callback(offset));
          offset = offset.add(packetSize);
          nbRemainingPackets++;
        }
      }
      checkDone();
    }
  });
}


/*
 * writeFile
 * =========
 *
 * create and write file on the share
 *
 *  - create the file
 *
 *  - set info of the file
 *
 *  - set content of the file
 *
 *  - close the file
 *
 */
proto.writeFile = function(src, dest, cb){
  var connection = this
    , file
    , fileContent
    , fileLength
    ;

  function createFile(fileCreated){
    SMB2Request('create', {path:dest}, connection, function(err, f){
      if(err) cb && cb(err);
      // SMB2 set file size
      else {
        file = f;
        fileCreated();
      }
    });
  }

  function closeFile(fileClosed){
    SMB2Request('close', file, connection, function(err){
      if(err) cb && cb(err);
      else {
        file = null;
        fileClosed();
      }
    });
  }

  function openFile(fileOpened){
    SMB2Request('open', {path:dest}, connection, function(err, f){
      if(err) cb && cb(err);
      // SMB2 read file content
      else {
        file = f;
        fileOpened();
      }
    });
  }

  function openSrcFile(fileOpened){
    fileContent = fs.readFileSync(src);
    fileLength = new bigint(8, fileContent.length);
    fileOpened();
  }

  function setFileSize(fileSizeSetted){
    SMB2Request('set_info', {FileId:file.FileId, FileInfoClass:'FileEndOfFileInformation', Buffer:fileLength.toBuffer()}, connection, function(err){
      if(err) cb && cb(err);
      else fileSizeSetted();
    });
  }

  function writeFile(fileWritten){
    var offset = new bigint(8)
      , stop = false
      , nbRemainingPackets = 0
      , maxPacketSize = new bigint(8, 0x00010000 - 0x71)
      ;
    // callback manager
    function callback(offset){
      return function(err){
        if(stop) return;
        if(err) {
          cb && cb(err);
          stop = true;
        } else {
          nbRemainingPackets--;
          checkDone();
        }
      }
    }
    // callback manager
    function checkDone(){
      if(stop) return;
      createPackets();
      if(nbRemainingPackets==0 && offset.ge(fileLength)) {
        fileWritten();
      }
    }
    // create packets
    function createPackets(){
      while(nbRemainingPackets<connection.packetConcurrency && offset.lt(fileLength)){
        // process packet size
        var rest = fileLength.sub(offset);
        var packetSize = rest.gt(maxPacketSize) ? maxPacketSize : rest;
        // generate buffer
        SMB2Request('write', {
          'FileId':file.FileId
        , 'Offset':offset.toBuffer()
        , 'Buffer':fileContent.slice(offset.toNumber(), offset.add(packetSize).toNumber())
        }, connection, callback(offset));
        offset = offset.add(packetSize);
        nbRemainingPackets++;
      }
    }
    checkDone();
  }

  this.fileExists(dest, function(err, exists){

    if(err) cb && cb(err);

    else if(!exists){

      createFile(function(){
        openSrcFile(function(){
          setFileSize(function(){
            writeFile(function(){
              closeFile(cb);
            });
          });
        });
      });

    } else {

      cb(new Error('File already exists'));

    }

  });

}


/*
 * fileExists
 * =========
 *
 * test the existence of a file
 *
 *  - try to open the file
 *
 *  - close the file
 *
 */
proto.fileExists = function(path, cb){

  var connection = this;

  SMB2Request('open', {path:path}, connection, function(err, file){
    if(err) cb && cb(null, false);
    else SMB2Request('close', file, connection, function(err){
      cb && cb(null, true);
    });
  });

}


/*
 * unlinkFile
 * ==========
 *
 * remove file:
 *
 *  - open the file
 *
 *  - remove the file
 *
 *  - close the file
 *
 */
proto.unlinkFile = function(path, cb){
  var connection = this;

  this.fileExists(path, function(err, exists){

    if(err) cb && cb(err);

    else if(exists){

      // SMB2 open file
      SMB2Request('create', {path:path}, connection, function(err, file){
        if(err) cb && cb(err);
        // SMB2 query directory
        else SMB2Request('set_info', {FileId:file.FileId, FileInfoClass:'FileDispositionInformation',Buffer:(new bigint(1,1)).toBuffer()}, connection, function(err, files){
          if(err) cb && cb(err);
          // SMB2 close directory
          else SMB2Request('close', file, connection, function(err){
            cb && cb(err, files);
          });
        });
      });

    } else {

      cb(new Error('File does not exists'));

    }

  });

}


/*
 * MESSAGE MANAGMENT
 */
function SMB2Request(messageName, params, connection, cb){
  var msg = require('./messages/'+messageName)
    , smbMessage = msg.generate(connection, params)
    ;
  // send
  sendNetBiosMessage(
    connection
  , smbMessage
  );
  // wait for the response
  getResponse(
    connection
  , smbMessage.getHeaders().MessageId
  , msg.parse(connection, cb)
  );
}


function sendNetBiosMessage(connection, message) {
  var smbRequest = message.getBuffer();

  if(connection.debug){
    console.log('--request');
    console.log(smbRequest.toString('hex'));
  }

  // create NetBios package
  var buffer = new Buffer(smbRequest.length+4);

  // write NetBios cmd
  buffer.writeUInt8(0x00, 0);

  // write message length
  buffer.writeUInt8((0xFF0000 & smbRequest.length) >> 16, 1);
  buffer.writeUInt16BE(0xFFFF & smbRequest.length, 2);

  // write message content
  smbRequest.copy(buffer, 4, 0, smbRequest.length);


  // Send it !!!
  connection.newResponse = false;
  connection.socket.write(buffer);


  return true;
}


function parseResponse(c){
  c.responses = {};
  c.responsesCB = {};
  c.responseBuffer = new Buffer(0);
  return function(response){
    // concat new response
    c.responseBuffer = Buffer.concat([c.responseBuffer, response]);
    // extract complete messages
    var extract = true;
    while(extract){
      extract = false;
      // has a message header
      if(c.responseBuffer.length >= 4) {
        // message is complete
        var msgLength = (c.responseBuffer.readUInt8(1) << 16) + c.responseBuffer.readUInt16BE(2);
        if(c.responseBuffer.length >= msgLength + 4) {
          // set the flags
          extract = true;
          // parse message
          var r = c.responseBuffer.slice(4, msgLength+4)
            , message = new SMB2Message()
            ;
          message.parseBuffer(r);
          //debug
          if(c.debug){
            console.log('--response');
            console.log(r.toString('hex'));
          }
          // get the message id
          var mId = message.getHeaders().MessageId.toString('hex');
          // check if the message can be dispatched
          // or store it
          if(c.responsesCB[mId]) {
            c.responsesCB[mId](message);
            delete c.responsesCB[mId];
          } else {
            c.responses[mId] = message;
          }
          // remove from response buffer
          c.responseBuffer = c.responseBuffer.slice(msgLength+4);
        }
      }
    }
  }
}

function getResponse(c, mId, cb) {
  var messageId = new Buffer(4);
  messageId.writeUInt32LE(mId, 0);
  messageId = messageId.toString('hex');
  if(c.responses[messageId]) {
    cb(c.responses[messageId]);
    delete c.responses[messageId];
  } else {
    c.responsesCB[messageId] = cb;
  }
}

