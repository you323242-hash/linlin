export async function preparePersonaImage(file,{avatar=false}={}){
  if(!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>4*1024*1024)throw Error('请选择4MB以内的JPEG、PNG或WebP图片。');
  const bitmap=await createImageBitmap(file);
  try{
    if(Math.min(bitmap.width,bitmap.height)<16 || Math.max(bitmap.width,bitmap.height)>8192)throw Error('图片边长须在16—8192像素之间。');
    const canvas=document.createElement('canvas'),ratio=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
    canvas.width=avatar?384:Math.round(bitmap.width*ratio);canvas.height=avatar?384:Math.round(bitmap.height*ratio);
    const ctx=canvas.getContext('2d');ctx.fillStyle='#eef3f6';ctx.fillRect(0,0,canvas.width,canvas.height);
    if(avatar){const s=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-s)/2,(bitmap.height-s)/2,s,s,0,0,384,384);}else ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    for(const quality of [.84,.7,.55]){const url=canvas.toDataURL('image/jpeg',quality);if(url.split(',')[1].length<=(avatar?174764:524288))return {url,content:url.split(',')[1]};}
    throw Error('图片压缩后仍过大，请换一张图片。');
  }finally{bitmap.close();}
}
