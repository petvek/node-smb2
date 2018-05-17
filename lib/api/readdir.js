var FileTime = require('win32filetime');

var SMB2Forge = require('../tools/smb2-forge')
  , SMB2Request = SMB2Forge.request
  ;

/*
 * readdir
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

function bufferToDate(buf) {
  var low = buf.readUInt32LE(0);
  var high = buf.readUInt32LE(4);
  return FileTime.toDate({low: low, high: high}).toISOString()
}

function bufferToInt(buf) {
  return (buf.readUInt32LE(4) << 8) + buf.readUInt32LE(0);
}

module.exports = function(path, options, cb){
  var connection = this;

  // SMB2 open directory
  SMB2Request('open', {path:path}, connection, function(err, file){
    if(err) cb && cb(err);
    // SMB2 query directory
    else SMB2Request('query_directory', file, connection, function(err, files){
      if(err) cb && cb(err);
      // SMB2 close directory
      else SMB2Request('close', file, connection, function(err){
        cb && cb(
          null
        , files
            .filter(function(v){ return v.Filename!='.' && v.Filename!='..' }) // remove '.' and '..' values
            .map(function(v){ return options.verbose ? {
              filename: v.Filename,
              lastWriteTime: bufferToDate(v.LastWriteTime),
              size: bufferToInt(v.EndofFile)
            } : v.Filename })
        );
      });
    });
  });
}


