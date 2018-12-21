
const { shiftModel } = require('../connection');

async function shiftList(args){
    
    const query = args.query || { };
    const proj  = args.proj  || { };
  
    /* Utilize projection options in args */
    proj.sort = args.sort;
    proj.skip = args.skip;
    proj.limit = args.limit;
    proj.fields = args.fields;
  
    return await shiftModel.find(query, proj);
}


module.exports = {
    shiftList
}